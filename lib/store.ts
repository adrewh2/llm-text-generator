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
 * Lightweight status lookup for the /api/p/[id] poll path.
 *
 * Returns everything the UI needs to render an *in-flight* crawl —
 * status, progress, error, site metadata — while deliberately
 * skipping `pages.result` and `pages.crawled_pages`. Those two
 * columns hold the terminal payload (~a few KB of markdown + ~10 KB
 * of scored-page JSONB) and are only useful once the job is
 * terminal. Pulling them on every poll also drags the previous
 * terminal value along during monitor-triggered re-crawls, which is
 * pure wire-waste since the route would drop them before responding.
 *
 * Poll path shape: light query here first. If status is terminal,
 * the route falls back to `getPageById` to include the payload.
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
  }
}

/**
 * Full page lookup including the terminal payload (`result` +
 * `crawled_pages`). Used by the /p/[id] RSC first-paint and by the
 * /api/p/[id] poll path on terminal status only. For in-flight polls
 * use `getPageStatusById` — cheaper, skips the TOAST fetch.
 */
export async function getPageById(pageId: string): Promise<CrawlJob | undefined> {
  const supabase = getClient()
  // Single round-trip: fetch the page row plus its latest job via
  // PostgREST's embedded-resource syntax against the jobs_page_url_fkey
  // foreign key. `!` disambiguates the FK path, and the inner
  // order/limit narrow the embedded array to exactly the newest job.
  const { data: page } = await supabase
    .from("pages")
    .select(`
      id,
      url,
      result,
      crawled_pages,
      site_name,
      genre,
      jobs:jobs!jobs_page_url_fkey(id, status, progress, site_name, genre, error, created_at, updated_at)
    `)
    .eq("id", pageId)
    .order("created_at", { foreignTable: "jobs", ascending: false })
    .limit(1, { foreignTable: "jobs" })
    .maybeSingle()
  if (!page) return undefined

  // A monitor-triggered re-crawl in flight should surface as a non-
  // terminal status even when `pages.result` is still the previous
  // terminal output, so the UI can show "Refreshing…".
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
      // Build the upsert payload so an omitted `pages` leaves the prior
      // `crawled_pages` alone. A callsite that writes a fresh `result`
      // but doesn't re-submit the page list (e.g. a future re-assembly
      // path) would otherwise wipe the cached explorer data on every
      // write.
      const pagesUpdate: Record<string, unknown> = {
        url: job.page_url,
        result: updates.result,
        site_name: updates.siteName ?? job.site_name ?? null,
        genre: updates.genre ?? job.genre ?? null,
        // A fresh crawl is itself the strongest check signal — set
        // last_checked_at so the dashboard doesn't dangle on "Awaiting
        // check" until the next cron tick.
        last_checked_at: now,
        updated_at: now,
      }
      if (updates.pages !== undefined) pagesUpdate.crawled_pages = updates.pages
      // Returning the id from the upsert saves an extra SELECT on the
      // revalidation path — previously we upserted, then re-queried
      // the same row just to learn its UUID.
      const { data: pageRow, error: pagesErr } = await supabase
        .from("pages")
        .upsert(pagesUpdate, { onConflict: "url" })
        .select("id")
        .maybeSingle()
      if (pagesErr) {
        errorLog("store.updateJob.pages", new Error(`${id}: ${pagesErr.message}`))
        throw new Error(pagesErr.message)
      }

      // /api/p/:pageId is 1:1 with this page row (page id stays stable
      // across re-crawls), so a single revalidation covers the
      // terminal-response cache.
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
 * Record user activity on a page's URL: refresh `last_requested_at`
 * (so the daily sweeper keeps the page in the monitor rotation) and
 * re-assert `monitored = true` (recovery if a prior sweep had flipped
 * it off and the user has now come back).
 *
 * Fired from every user-facing entry point to a page: POST /api/p
 * on all three branches, GET /api/p/[id] on non-failed polls, and
 * the /p/[id] RSC render (the important one — it catches users who
 * click into a cached page from their dashboard and then read it
 * without the client polling, because the terminal poll response is
 * CDN-cached and wouldn't reach our server).
 *
 * Per-instance cooldown: the sweeper only cares about freshness
 * within `monitor.STALE_DAYS` (5 d), so the first bump per window
 * writes and subsequent bumps inside the window are no-ops. Worst-
 * case staleness across Fluid instances is `BUMP_COOLDOWN_MS`, which
 * is negligible against a 5-day cutoff.
 *
 * No-op if the page doesn't exist yet (UPDATE with no matching row).
 * Errors go to Sentry so a Supabase outage here doesn't silently
 * drift sweeper decisions — the caller doesn't wait on this
 * (fire-and-forget) so we log instead of throwing.
 */
const BUMP_COOLDOWN_MS = 5 * 60 * 1000
const lastBumpAt = new Map<string, number>()
export async function bumpPageRequest(pageUrl: string): Promise<void> {
  const now = Date.now()
  const last = lastBumpAt.get(pageUrl) ?? 0
  if (now - last < BUMP_COOLDOWN_MS) return
  lastBumpAt.set(pageUrl, now)

  const supabase = getClient()
  const { error } = await supabase
    .from("pages")
    .update({
      last_requested_at: new Date().toISOString(),
      // Recover the monitor flag on user activity. Without this, a page
      // that was swept while the user was away stays out of the monitor
      // rotation even as they come back and keep viewing it.
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

/**
 * Check whether a (user, page_url) association exists. Cheap lookup
 * against the UNIQUE(user_id, page_url) index — used by the result
 * page to decide whether to show the "Add to dashboard" affordance.
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
