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
    requireEnv("SUPABASE_URL"),
    requireEnv("SUPABASE_SERVICE_ROLE_KEY"),
    { auth: { persistSession: false, autoRefreshToken: false } },
  )
  return cached
}

// ─── Jobs ────────────────────────────────────────────────────────────────────

/**
 * Upsert the page row (FK target, monitoring re-enabled) and insert a
 * new crawl job against it. Returns the page's UUID — the user-facing
 * identifier that /p/{pageId} routes against. `jobId` stays internal:
 * the worker uses it to update row status; no URL references it.
 */
export async function createJob(jobId: string, url: string): Promise<{ pageId: string }> {
  // Defense-in-depth: every job-creation path (submit, monitor
  // re-crawl, future callers) flows through here, so re-validate the
  // URL even if the caller already did. Blocks loopback / private /
  // metadata / non-default-port / DNS-unresolvable targets before we
  // upsert a pages row or insert a jobs row — makes it impossible to
  // persist a job for an unreachable or unsafe page. Throws
  // UnsafeUrlError; callers at HTTP boundaries translate to 400.
  await assertSafeUrl(url)

  const supabase = getClient()
  // pages row must exist before the job (FK). `DEFAULT gen_random_uuid()`
  // generates `id` on INSERT and leaves existing rows' ids untouched on
  // conflict — one page URL maps to exactly one UUID for its lifetime.
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
 * Primary lookup for /api/p/[id]. Resolves a user-facing page UUID to
 * the page's current state — the latest job's status/progress/error,
 * plus the page's cached result when the job is terminal. The
 * returned `id` is the page id (matches the param), not any job id.
 */
export async function getPageById(pageId: string): Promise<CrawlJob | undefined> {
  const supabase = getClient()
  const { data: page } = await supabase
    .from("pages")
    .select("id, url, result, crawled_pages, site_name, genre")
    .eq("id", pageId)
    .maybeSingle()
  if (!page) return undefined

  // Latest job for this URL — any status. A monitor-triggered re-crawl
  // in flight should surface as a non-terminal status even if the page
  // already has a cached result, so the UI can show "Refreshing…".
  const { data: job } = await supabase
    .from("jobs")
    .select("*")
    .eq("page_url", page.url)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle()
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

  // Write the pages row FIRST (before the job status flip) so polling
  // clients never see status=complete with result=null. Skip if
  // updates.result is empty so a failed re-crawl can't wipe the last
  // good result.
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
      const { error: pagesErr } = await supabase.from("pages").upsert({
        url: job.page_url,
        result: updates.result,
        site_name: updates.siteName ?? job.site_name ?? null,
        genre: updates.genre ?? job.genre ?? null,
        crawled_pages: updates.pages ?? null,
        // A fresh crawl is itself the strongest check signal — set
        // last_checked_at so the dashboard doesn't dangle on "Awaiting
        // check" until the next cron tick.
        last_checked_at: now,
        updated_at: now,
      }, { onConflict: "url" })
      if (pagesErr) {
        errorLog("store.updateJob.pages", new Error(`${id}: ${pagesErr.message}`))
        throw new Error(pagesErr.message)
      }

      // /api/p/:pageId is 1:1 with this page row now (page id stays
      // stable across re-crawls), so a single revalidation covers the
      // terminal-response cache.
      const { data: pageRow } = await supabase
        .from("pages")
        .select("id")
        .eq("url", job.page_url)
        .maybeSingle()
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
 * Returns the page's UUID (user-facing id) plus TTL staleness for a
 * given canonical URL, or undefined if no terminal result exists yet.
 * Callers use `pageId` to build the `/p/{id}` redirect and `isStale`
 * to decide whether to dispatch a fresh crawl.
 */
export async function getPageByUrl(url: string): Promise<{ pageId: string; isStale: boolean } | undefined> {
  const supabase = getClient()
  const { data: page } = await supabase
    .from("pages")
    .select("id, updated_at")
    .eq("url", url)
    .not("result", "is", null)
    .maybeSingle()
  if (!page) return undefined

  const ageHours = (Date.now() - new Date(page.updated_at).getTime()) / 3_600_000
  const isStale = ageHours >= PAGE_TTL_HOURS
  return { pageId: page.id, isStale }
}

/**
 * Returns the page's UUID if a crawl is in flight for that URL (no
 * terminal status, updated within the stuck-job window). Used by
 * POST /api/p to attach a new submission to an existing run instead
 * of kicking off a duplicate. Returns undefined otherwise.
 *
 * Ignores stale non-terminal jobs (updated_at older than
 * STUCK_JOB_AFTER_MS) so a dead waitUntil() doesn't trap future
 * submissions until the daily monitor sweep force-fails the row.
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
 * Mark jobs wedged in a non-terminal status past the pipeline budget
 * as failed. QStash retries up to 3×, then drops the message; a worker
 * crash on the final attempt otherwise leaves the job row in
 * `crawling` forever, which `getActiveJobForUrl` then keeps returning
 * as a phantom "in-flight" job to every future submitter. Cheap
 * cleanup — runs at the head of the monitor cron.
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
 * Bump `pages.last_requested_at` — called whenever a user interacts
 * with a page's URL, so the sweeper can tell dormant URLs from active
 * ones. No-op if the page doesn't exist yet.
 */
export async function bumpPageRequest(pageUrl: string): Promise<void> {
  const supabase = getClient()
  await supabase
    .from("pages")
    .update({ last_requested_at: new Date().toISOString() })
    .eq("url", pageUrl)
}

// ─── User requests ────────────────────────────────────────────────────────────

export async function upsertUserRequest(userId: string, pageUrl: string): Promise<void> {
  const supabase = getClient()
  // Explicitly pass created_at so re-requesting a URL refreshes the
  // timestamp (on conflict the upsert writes whatever we send; the
  // DEFAULT NOW() only fires on INSERT). This makes the dashboard
  // order-by created_at DESC surface the most recently-asked-about
  // page at the top — a user who's made many requests shouldn't have
  // to page past history to find a URL they just re-submitted.
  await supabase.from("user_requests").upsert(
    { user_id: userId, page_url: pageUrl, created_at: new Date().toISOString() },
    { onConflict: "user_id,page_url" }
  )
}

export async function removeUserRequest(userId: string, pageUrl: string): Promise<void> {
  const supabase = getClient()
  await supabase.from("user_requests").delete().eq("user_id", userId).eq("page_url", pageUrl)
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
 * Fetch pages in a user's history along with their current llms.txt
 * results. Used by /api/pages/download to build the zip archive. Rows
 * without a result (crawl not yet complete) are skipped. `limit`
 * caps the query so a user with thousands of pages can't OOM the
 * download function.
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

  // Fetch page metadata — `id` is the dashboard-row link target.
  const { data: pages } = await supabase
    .from("pages")
    .select("id, url, site_name, genre, monitored, last_checked_at")
    .in("url", pageUrls)

  // Fetch the latest job status per page_url (any status). A monitor-
  // triggered re-crawl should surface as "Refreshing…" on the row
  // even while the page still has a cached terminal result, so we
  // look at the newest job, not just terminal ones.
  const { data: jobs } = await supabase
    .from("jobs")
    .select("page_url, status, created_at")
    .in("page_url", pageUrls)
    .order("created_at", { ascending: false })

  const pageMap = new Map((pages ?? []).map((p) => [p.url, p]))
  // Keep only the most recent job's status per page_url. `jobs` was
  // ordered created_at DESC, so the first one seen per url wins.
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
