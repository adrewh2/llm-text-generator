import { createClient } from "@supabase/supabase-js"
import type { CrawlJob, ScoredPage } from "./crawler/types"
import { PAGE_TTL_HOURS } from "./crawler/config"

// Server-only store: uses the service role key so writes bypass RLS.
// This key must never be exposed to the client.
function getClient() {
  const url = process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY")
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } })
}

// ─── Jobs ────────────────────────────────────────────────────────────────────

export async function createJob(id: string, url: string): Promise<void> {
  const supabase = getClient()
  // Ensure the pages row exists before inserting the job (FK requires it)
  await supabase.from("pages").upsert({ url }, { onConflict: "url", ignoreDuplicates: true })
  const { error } = await supabase.from("jobs").insert({
    id,
    page_url: url,
    status: "pending",
    progress: { discovered: 0, crawled: 0, failed: 0 },
  })
  if (error) throw new Error(error.message)
}

export async function getJob(id: string): Promise<CrawlJob | undefined> {
  const supabase = getClient()
  const { data: job, error } = await supabase.from("jobs").select("*").eq("id", id).single()
  if (error || !job) return undefined

  let pageResult: { result: string; crawled_pages: ScoredPage[] | null } | null = null
  if (job.status === "complete" || job.status === "partial") {
    const { data: page } = await supabase
      .from("pages")
      .select("result, crawled_pages")
      .eq("url", job.page_url)
      .single()
    pageResult = page ?? null
  }

  return {
    id: job.id,
    url: job.page_url,
    status: job.status,
    progress: job.progress,
    genre: job.genre ?? undefined,
    siteName: job.site_name ?? undefined,
    result: pageResult?.result ?? undefined,
    pages: (pageResult?.crawled_pages ?? undefined) as ScoredPage[] | undefined,
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

  await supabase.from("jobs").update(jobRow).eq("id", id)

  // When the result is ready, write the canonical page — only if non-empty
  // so a failed re-crawl never wipes out the previous good result
  if (updates.result !== undefined && updates.result.trim().length > 0) {
    const { data: job } = await supabase
      .from("jobs")
      .select("page_url, site_name, genre")
      .eq("id", id)
      .single()

    if (job) {
      await supabase.from("pages").upsert({
        url: job.page_url,
        result: updates.result,
        site_name: updates.siteName ?? job.site_name ?? null,
        genre: updates.genre ?? job.genre ?? null,
        crawled_pages: updates.pages ?? null,
        updated_at: now,
      }, { onConflict: "url" })
    }
  }
}

// ─── Pages ───────────────────────────────────────────────────────────────────


export async function getPageByUrl(url: string): Promise<{ jobId: string; isStale: boolean } | undefined> {
  const supabase = getClient()
  const { data: page } = await supabase
    .from("pages")
    .select("url, updated_at")
    .eq("url", url)
    .not("result", "is", null)
    .maybeSingle()
  if (!page) return undefined

  const ageHours = (Date.now() - new Date(page.updated_at).getTime()) / 3_600_000
  const isStale = ageHours >= PAGE_TTL_HOURS

  const { data: job } = await supabase
    .from("jobs")
    .select("id")
    .eq("page_url", url)
    .in("status", ["complete", "partial"])
    .order("created_at", { ascending: false })
    .limit(1)
    .single()

  return job ? { jobId: job.id, isStale } : undefined
}

export async function getActiveJobForUrl(url: string): Promise<{ jobId: string } | undefined> {
  const supabase = getClient()
  const { data: job } = await supabase
    .from("jobs")
    .select("id")
    .eq("page_url", url)
    .not("status", "in", '("failed","complete","partial")')
    .order("created_at", { ascending: false })
    .limit(1)
    .single()
  return job ? { jobId: job.id } : undefined
}

// ─── User requests ────────────────────────────────────────────────────────────

export async function upsertUserRequest(userId: string, pageUrl: string): Promise<void> {
  const supabase = getClient()
  await supabase.from("user_requests").upsert(
    { user_id: userId, page_url: pageUrl },
    { onConflict: "user_id,page_url" }
  )
}

export async function removeUserRequest(userId: string, pageUrl: string): Promise<void> {
  const supabase = getClient()
  await supabase.from("user_requests").delete().eq("user_id", userId).eq("page_url", pageUrl)
}

export async function getUserPages(userId: string): Promise<Array<{
  pageUrl: string
  siteName: string | null
  genre: string | null
  requestedAt: Date
  latestJobId: string | null
  latestJobStatus: string | null
}>> {
  const supabase = getClient()
  const { data } = await supabase
    .from("user_requests")
    .select("page_url, created_at")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(200)

  if (!data || data.length === 0) return []

  const pageUrls = data.map((r) => r.page_url)

  // Fetch page metadata
  const { data: pages } = await supabase
    .from("pages")
    .select("url, site_name, genre")
    .in("url", pageUrls)

  // Fetch latest job per page_url
  const { data: jobs } = await supabase
    .from("jobs")
    .select("id, page_url, status, created_at")
    .in("page_url", pageUrls)
    .in("status", ["complete", "partial"])
    .order("created_at", { ascending: false })

  const pageMap = new Map((pages ?? []).map((p) => [p.url, p]))
  // Keep only most recent job per page_url
  const jobMap = new Map<string, { id: string; status: string }>()
  for (const j of (jobs ?? [])) {
    if (!jobMap.has(j.page_url)) jobMap.set(j.page_url, { id: j.id, status: j.status })
  }

  return data.map((r) => {
    const page = pageMap.get(r.page_url)
    const job = jobMap.get(r.page_url)
    return {
      pageUrl: r.page_url,
      siteName: page?.site_name ?? null,
      genre: page?.genre ?? null,
      requestedAt: new Date(r.created_at),
      latestJobId: job?.id ?? null,
      latestJobStatus: job?.status ?? null,
    }
  })
}
