import { NextRequest, NextResponse } from "next/server"
import { randomUUID } from "crypto"
import { bumpPageRequest, createJob, getActiveJobForUrl, getPageByUrl, upsertUserRequest } from "@/lib/store"
import { runCrawlPipeline } from "@/lib/crawler/pipeline"
import { isValidHttpUrl, normalizeUrl } from "@/lib/crawler/url"
import { waitUntil } from "@vercel/functions"
import { createClient } from "@/lib/supabase/server"

export const runtime = "nodejs"
export const maxDuration = 300

export async function POST(req: NextRequest) {
  let body: { url?: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }

  const { url } = body
  if (!url || typeof url !== "string") {
    return NextResponse.json({ error: "url is required" }, { status: 400 })
  }
  if (!isValidHttpUrl(url.trim())) {
    return NextResponse.json({ error: "Invalid URL — must be http:// or https://" }, { status: 400 })
  }

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  // Resolve canonical URL. The redirect target often carries per-request
  // session/OAuth tokens (e.g. Google's dsh/ifkv/osid); those expire and
  // must not be stored as part of the cache key — strip them via our
  // normalizer so the canonical URL is stable across re-submissions.
  let canonicalUrl = url.trim()
  try {
    const probe = await fetch(canonicalUrl, { method: "HEAD", redirect: "follow", signal: AbortSignal.timeout(5000) })
    canonicalUrl = probe.url || canonicalUrl
  } catch { /* use original */ }
  canonicalUrl = normalizeUrl(canonicalUrl) || canonicalUrl

  // Check for an existing result
  const existing = await getPageByUrl(canonicalUrl)

  if (existing && !existing.isStale) {
    // Fresh cached result — serve immediately with simulated animation
    await bumpPageRequest(canonicalUrl)
    if (user) await upsertUserRequest(user.id, canonicalUrl)
    return NextResponse.json({ page_id: existing.jobId, cached: true }, { status: 200 })
  }

  // In-progress job already running for this URL — attach to it
  const active = await getActiveJobForUrl(canonicalUrl)
  if (active) {
    await bumpPageRequest(canonicalUrl)
    return NextResponse.json({ page_id: active.jobId, cached: false }, { status: 200 })
  }

  // Stale or new — run a fresh crawl. The user_request row is created
  // by GET /api/p/[id] once the job completes and the user views it —
  // this is intentional: forcing the user to wait on /p/[id] through
  // to completion gates each submission against their own attention,
  // which acts as a lightweight rate limit.
  const id = randomUUID()
  await createJob(id, canonicalUrl)
  await bumpPageRequest(canonicalUrl)
  waitUntil(runCrawlPipeline(id, canonicalUrl))

  return NextResponse.json({ page_id: id, cached: false }, { status: 201 })
}
