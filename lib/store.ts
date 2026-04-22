import { createClient, type SupabaseClient } from "@supabase/supabase-js"
import { revalidatePath } from "next/cache"
import type { CrawlJob, ScoredPage } from "./crawler/types"
import { crawler, monitor } from "./config"
import { assertSafeUrl } from "./crawler/net/ssrf"
import { requireEnv } from "./env"
import { errorLog } from "./log"

const { PAGE_TTL_HOURS } = crawler

// Server-only store: uses the service role key so writes bypass RLS.
// Must never be imported into client code. Lazy singleton.
let cached: SupabaseClient | null = null
function getClient(): SupabaseClient {
  if (cached) return cached
  cached = createClient(
    requireEnv("NEXT_PUBLIC_SUPABASE_URL"),
    requireEnv("SUPABASE_SERVICE_ROLE_KEY"),
    { auth: { persistSession: false, autoRefreshToken: false } },
  )
  return cached
}

// ─── Jobs ────────────────────────────────────────────────────────────────────

/**
 * Upsert the page row and insert a crawl job. Returns the page's UUID —
 * the user-facing id behind /p/{pageId}. `jobId` stays internal.
 */
export async function createJob(jobId: string, url: string): Promise<{ pageId: string }> {
  // Defense-in-depth: re-validate even if the caller already did, so
  // every job-creation path is covered. Throws UnsafeUrlError.
  await assertSafeUrl(url)

  const supabase = getClient()
  // pages row must exist before the job (FK). UUID generated on INSERT,
  // preserved on conflict — one URL ↔ one page id for its lifetime.
  const { data: page, error: pageErr } = await supabase
    .from("pages")
    .upsert({ url, monitored: true }, { onConflict: "url" })
    .select("id")
    .single()
  if (pageErr || !page) throw new Error(pageErr?.message ?? "failed to upsert page")

  const { error: jobErr } = await supabase.from("jobs").insert({
    id: jobId,
    page_url: url,
    status: "pending",
    progress: { discovered: 0, crawled: 0, failed: 0 },
  })
  if (jobErr) throw new Error(jobErr.message)

  return { pageId: page.id }
}

/**
 * Lightweight status lookup for the /api/p/[id] poll path — skips the
 * terminal payload (`result` + `crawled_pages`). Route falls back to
 * `getPageById` when the status is terminal.
 */
export async function getPageStatusById(pageId: string): Promise<CrawlJob | undefined> {
  const supabase = getClient()
  const { data: page } = await supabase
    .from("pages")
    .select(`
      id,
      url,
      site_name,
      genre,
      last_checked_at,
      jobs:jobs!jobs_page_url_fkey(id, status, progress, site_name, genre, error, created_at, updated_at)
    `)
    .eq("id", pageId)
    .order("created_at", { foreignTable: "jobs", ascending: false })
    .limit(1, { foreignTable: "jobs" })
    .maybeSingle()
  if (!page) return undefined

  const job = Array.isArray(page.jobs) ? page.jobs[0] : null
  if (!job) return undefined

  return {
    id: page.id,
    url: page.url,
    status: job.status,
    progress: job.progress,
    genre: (job.genre ?? page.genre) ?? undefined,
    siteName: (job.site_name ?? page.site_name) ?? undefined,
    // Intentionally omitted — use getPageById for terminal-payload reads.
    result: undefined,
    pages: undefined,
    error: job.error ?? undefined,
    createdAt: new Date(job.created_at),
    updatedAt: new Date(job.updated_at),
    lastCheckedAt: page.last_checked_at ? new Date(page.last_checked_at) : undefined,
  }
}

/**
 * Full page lookup including terminal payload. Used by /p/[id] RSC
 * first-paint and the poll path once terminal. For in-flight polls,
 * prefer `getPageStatusById`.
 */
export async function getPageById(pageId: string): Promise<CrawlJob | undefined> {
  const supabase = getClient()
  const { data: page } = await supabase
    .from("pages")
    .select(`
      id,
      url,
      result,
      crawled_pages,
      site_name,
      genre,
      last_checked_at,
      jobs:jobs!jobs_page_url_fkey(id, status, progress, site_name, genre, error, created_at, updated_at)
    `)
    .eq("id", pageId)
    .order("created_at", { foreignTable: "jobs", ascending: false })
    .limit(1, { foreignTable: "jobs" })
    .maybeSingle()
  if (!page) return undefined

  // A monitor-triggered re-crawl should surface as non-terminal even
  // while `pages.result` still holds the previous output (UI: "Refreshing…").
  const job = Array.isArray(page.jobs) ? page.jobs[0] : null
  if (!job) return undefined

  const isTerminal = job.status === "complete" || job.status === "partial"

  return {
    id: page.id,
    url: page.url,
    status: job.status,
    progress: job.progress,
    genre: (job.genre ?? page.genre) ?? undefined,
    siteName: (job.site_name ?? page.site_name) ?? undefined,
    result: isTerminal ? page.result ?? undefined : undefined,
    pages: isTerminal ? (page.crawled_pages as ScoredPage[] | null) ?? undefined : undefined,
    error: job.error ?? undefined,
    createdAt: new Date(job.created_at),
    updatedAt: new Date(job.updated_at),
    lastCheckedAt: page.last_checked_at ? new Date(page.last_checked_at) : undefined,
  }
}

export async function updateJob(id: string, updates: Partial<CrawlJob>): Promise<void> {
  const supabase = getClient()
  const now = new Date().toISOString()

  const jobRow: Record<string, unknown> = { updated_at: now }
  if (updates.status !== undefined) jobRow.status = updates.status
  if (updates.progress !== undefined) jobRow.progress = updates.progress
  if (updates.genre !== undefined) jobRow.genre = updates.genre
  if (updates.siteName !== undefined) jobRow.site_name = updates.siteName
  if (updates.error !== undefined) jobRow.error = updates.error

  // Write pages BEFORE the job status flip so polling clients never
  // see status=complete with result=null. Skip empty writes so a failed
  // re-crawl can't wipe the last good result.
  if (updates.result !== undefined && updates.result.trim().length > 0) {
    const { data: job, error: lookupErr } = await supabase
      .from("jobs")
      .select("page_url, site_name, genre")
      .eq("id", id)
      .maybeSingle()

    if (lookupErr) {
      // Throw so the worker returns non-2xx and QStash retries.
      errorLog("store.updateJob.lookup", new Error(`${id}: ${lookupErr.message}`))
      throw new Error(lookupErr.message)
    }

    if (job) {
      // Only set `crawled_pages` when the caller supplies it — an
      // omitted list must not wipe the cached explorer data.
      const pagesUpdate: Record<string, unknown> = {
        url: job.page_url,
        result: updates.result,
        site_name: updates.siteName ?? job.site_name ?? null,
        genre: updates.genre ?? job.genre ?? null,
        // A fresh crawl is the strongest check signal — stamp
        // last_checked_at so the dashboard doesn't wait for the cron.
        last_checked_at: now,
        updated_at: now,
      }
      if (updates.pages !== undefined) pagesUpdate.crawled_pages = updates.pages
      const { data: pageRow, error: pagesErr } = await supabase
        .from("pages")
        .upsert(pagesUpdate, { onConflict: "url" })
        .select("id")
        .maybeSingle()
      if (pagesErr) {
        errorLog("store.updateJob.pages", new Error(`${id}: ${pagesErr.message}`))
        throw new Error(pagesErr.message)
      }

      if (pageRow) revalidatePath(`/api/p/${pageRow.id}`)
    }
  }

  const { error: jobErr } = await supabase.from("jobs").update(jobRow).eq("id", id)
  if (jobErr) {
    errorLog("store.updateJob.jobs", new Error(`${id}: ${jobErr.message}`))
    throw new Error(jobErr.message)
  }
}

// ─── Pages ───────────────────────────────────────────────────────────────────


/**
 * Returns the page's UUID, TTL staleness, and drift signature for a
 * canonical URL — or undefined if no terminal result exists yet. The
 * signature lets the TTL-stale path skip a redundant re-crawl when
 * the site hasn't changed.
 */
export async function getPageByUrl(url: string): Promise<
  { pageId: string; isStale: boolean; contentSignature: string | null } | undefined
> {
  const supabase = getClient()
  const { data: page } = await supabase
    .from("pages")
    .select("id, updated_at, content_signature")
    .eq("url", url)
    .not("result", "is", null)
    .maybeSingle()
  if (!page) return undefined

  const ageHours = (Date.now() - new Date(page.updated_at).getTime()) / 3_600_000
  const isStale = ageHours >= PAGE_TTL_HOURS
  return {
    pageId: page.id,
    isStale,
    contentSignature: page.content_signature ?? null,
  }
}

/**
 * Returns the page's UUID if a crawl is in flight — used by POST /api/p
 * to attach to an existing run. Ignores stale non-terminal jobs
 * (updated_at older than STUCK_JOB_AFTER_MS) so a dead waitUntil()
 * doesn't trap future submissions.
 */
export async function getActiveJobForUrl(url: string): Promise<{ pageId: string } | undefined> {
  const supabase = getClient()
  const freshCutoff = new Date(Date.now() - monitor.STUCK_JOB_AFTER_MS).toISOString()
  const { data: job } = await supabase
    .from("jobs")
    .select("id")
    .eq("page_url", url)
    .not("status", "in", '("failed","complete","partial")')
    .gte("updated_at", freshCutoff)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle()
  if (!job) return undefined

  const { data: page } = await supabase
    .from("pages")
    .select("id")
    .eq("url", url)
    .maybeSingle()
  return page ? { pageId: page.id } : undefined
}

// ─── Monitoring ──────────────────────────────────────────────────────────────

export async function getMonitoredPages(
  { offset = 0, limit = 200 }: { offset?: number; limit?: number } = {},
): Promise<Array<{
  url: string
  contentSignature: string | null
}>> {
  const supabase = getClient()
  const { data } = await supabase
    .from("pages")
    .select("url, content_signature")
    .eq("monitored", true)
    .order("last_checked_at", { ascending: true, nullsFirst: true })
    .range(offset, offset + limit - 1)
  return (data ?? []).map((p) => ({
    url: p.url,
    contentSignature: p.content_signature ?? null,
  }))
}

export async function recordMonitorCheck(
  pageUrl: string,
  signature: string | null,
): Promise<void> {
  const supabase = getClient()
  const patch: Record<string, unknown> = { last_checked_at: new Date().toISOString() }
  // Only overwrite the signature when we actually computed one — a null
  // here means "detection failed this cycle", keep the previous sig so
  // we can still diff next time.
  if (signature !== null) patch.content_signature = signature
  await supabase.from("pages").update(patch).eq("url", pageUrl)
}

/**
 * Fail jobs wedged in non-terminal status past the pipeline budget,
 * so `getActiveJobForUrl` doesn't keep returning a phantom "in-flight"
 * job after a worker crash on the final QStash retry.
 */
export async function sweepStuckJobs(staleAfterMs: number): Promise<number> {
  const supabase = getClient()
  const cutoff = new Date(Date.now() - staleAfterMs).toISOString()
  const { count } = await supabase
    .from("jobs")
    .update(
      { status: "failed", error: "Worker did not complete in time", updated_at: new Date().toISOString() },
      { count: "exact" },
    )
    .not("status", "in", '("failed","complete","partial")')
    .lt("updated_at", cutoff)
  return count ?? 0
}

/**
 * Turn off monitoring on pages not requested in the last N days.
 * Returns the number of rows affected so the cron can report it.
 */
export async function sweepStaleMonitoredPages(staleAfterDays: number): Promise<number> {
  const supabase = getClient()
  const cutoff = new Date(Date.now() - staleAfterDays * 86_400_000).toISOString()
  const { count } = await supabase
    .from("pages")
    .update({ monitored: false }, { count: "exact" })
    .eq("monitored", true)
    .lt("last_requested_at", cutoff)
  return count ?? 0
}

/**
 * Record user activity on a page: refresh `last_requested_at` to keep
 * it in the monitor rotation, and re-assert `monitored = true` to
 * recover a page that had been swept while the user was away.
 * Fire-and-forget; errors log instead of throw.
 */
export async function bumpPageRequest(pageUrl: string): Promise<void> {
  const supabase = getClient()
  const { error } = await supabase
    .from("pages")
    .update({
      last_requested_at: new Date().toISOString(),
      monitored: true,
    })
    .eq("url", pageUrl)
  if (error) {
    errorLog("store.bumpPageRequest", new Error(`${pageUrl}: ${error.message}`))
  }
}

// ─── User requests ────────────────────────────────────────────────────────────

export async function upsertUserRequest(userId: string, pageUrl: string): Promise<void> {
  const supabase = getClient()
  // Explicit created_at refreshes the timestamp on conflict (DEFAULT
  // NOW() only fires on INSERT), so re-submitted pages bubble to the
  // top of the dashboard's created_at DESC list.
  await supabase.from("user_requests").upsert(
    { user_id: userId, page_url: pageUrl, created_at: new Date().toISOString() },
    { onConflict: "user_id,page_url" }
  )
}

export async function removeUserRequest(userId: string, pageUrl: string): Promise<void> {
  const supabase = getClient()
  await supabase.from("user_requests").delete().eq("user_id", userId).eq("page_url", pageUrl)
}

/**
 * Whether a (user, page_url) association exists. Used by the result
 * page to toggle the "Add to dashboard" affordance.
 */
export async function hasUserRequest(userId: string, pageUrl: string): Promise<boolean> {
  const supabase = getClient()
  const { data } = await supabase
    .from("user_requests")
    .select("id")
    .eq("user_id", userId)
    .eq("page_url", pageUrl)
    .maybeSingle()
  return !!data
}

export interface UserPageEntry {
  pageUrl: string
  pageId: string | null
  siteName: string | null
  genre: string | null
  requestedAt: Date
  latestJobStatus: string | null
  monitored: boolean
  lastCheckedAt: Date | null
}

/**
 * Pages in a user's history with their current llms.txt results.
 * Used by /api/pages/download. Rows without a result are skipped;
 * `limit` bounds memory for large histories.
 */
export async function getUserPageResults(
  userId: string,
  { limit = 500 }: { limit?: number } = {},
): Promise<Array<{
  url: string
  siteName: string | null
  result: string
}>> {
  const supabase = getClient()
  const { data: requests } = await supabase
    .from("user_requests")
    .select("page_url, created_at")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(limit)
  if (!requests || requests.length === 0) return []

  const urls = requests.map((r) => r.page_url)
  const { data: pages } = await supabase
    .from("pages")
    .select("url, site_name, result")
    .in("url", urls)

  const byUrl = new Map((pages ?? []).map((p) => [p.url, p]))
  return requests
    .map((r) => {
      const p = byUrl.get(r.page_url)
      if (!p?.result) return null
      return { url: p.url, siteName: p.site_name ?? null, result: p.result }
    })
    .filter((p): p is { url: string; siteName: string | null; result: string } => p !== null)
}

export async function getUserPages(
  userId: string,
  { offset = 0, limit = 20 }: { offset?: number; limit?: number } = {},
): Promise<UserPageEntry[]> {
  const supabase = getClient()
  const { data } = await supabase
    .from("user_requests")
    .select("page_url, created_at")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1)

  if (!data || data.length === 0) return []

  const pageUrls = data.map((r) => r.page_url)

  const { data: pages } = await supabase
    .from("pages")
    .select("id, url, site_name, genre, monitored, last_checked_at")
    .in("url", pageUrls)

  // Newest job (any status) so in-flight re-crawls surface as
  // "Refreshing…" even when pages.result still holds the last output.
  const { data: jobs } = await supabase
    .from("jobs")
    .select("page_url, status, created_at")
    .in("page_url", pageUrls)
    .order("created_at", { ascending: false })

  const pageMap = new Map((pages ?? []).map((p) => [p.url, p]))
  const statusMap = new Map<string, string>()
  for (const j of (jobs ?? [])) {
    if (!statusMap.has(j.page_url)) statusMap.set(j.page_url, j.status)
  }

  return data.map((r) => {
    const page = pageMap.get(r.page_url)
    return {
      pageUrl: r.page_url,
      pageId: page?.id ?? null,
      siteName: page?.site_name ?? null,
      genre: page?.genre ?? null,
      requestedAt: new Date(r.created_at),
      latestJobStatus: statusMap.get(r.page_url) ?? null,
      monitored: page?.monitored ?? false,
      lastCheckedAt: page?.last_checked_at ? new Date(page.last_checked_at) : null,
    }
  })
}
