import { NextRequest, NextResponse } from "next/server"
import { randomUUID } from "crypto"
import { bumpPageRequest, createJob, getActiveJobForUrl, getPageByUrl, upsertUserRequest } from "@/lib/store"
import { runCrawlPipeline } from "@/lib/crawler/pipeline"
import { isValidHttpUrl, normalizeUrl } from "@/lib/crawler/url"
import { safeFetch } from "@/lib/crawler/safeFetch"
import { clientIp, consumeRateLimit } from "@/lib/rateLimit"
import { api, rateLimit } from "@/lib/config"
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
  if (url.length > api.MAX_URL_LENGTH) {
    return NextResponse.json({ error: "URL is too long" }, { status: 400 })
  }
  if (!isValidHttpUrl(url.trim())) {
    return NextResponse.json({ error: "Invalid URL — must be http:// or https://" }, { status: 400 })
  }

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  // Rate limit — keyed by user id when signed in, IP when not. The
  // anon bucket is tiny so bots can't drain our LLM / Puppeteer
  // budget; signed-in users get a bigger one.
  const rateKey = user ? `user:${user.id}` : `ip:${clientIp(req)}`
  const rate = await consumeRateLimit(rateKey, user ? rateLimit.AUTH : rateLimit.ANON)
  if (!rate.allowed) {
    return NextResponse.json(
      {
        error: "Too many requests — please slow down.",
        // Hint the client to surface a Sign-In CTA. Anon users get
        // a tighter bucket than signed-in users; a nudge to sign in
        // is a reasonable response to the denial.
        signInPrompt: !user,
      },
      { status: 429, headers: { "Retry-After": String(rate.retryAfterSec) } },
    )
  }

  // Resolve canonical URL. The HEAD probe runs through safeFetch so
  // SSRF is enforced per-hop — otherwise an attacker could submit a
  // URL that 302-redirects to an internal IP and we'd happily probe
  // it. The redirect target often carries per-request session/OAuth
  // tokens (e.g. Google's dsh/ifkv/osid); those expire and must not
  // be stored as part of the cache key — strip them via our
  // normalizer so the canonical URL is stable across re-submissions.
  let canonicalUrl = url.trim()
  try {
    const probe = await safeFetch(canonicalUrl, {
      method: "HEAD",
      signal: AbortSignal.timeout(5000),
    })
    canonicalUrl = probe.url || canonicalUrl
  } catch {
    // Any validation / network failure here is recoverable: fall
    // through to the original submitted URL. The pipeline's own
    // assertSafeUrl will reject clearly-malicious URLs before the
    // first crawl fetch.
  }
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
    if (user) await upsertUserRequest(user.id, canonicalUrl)
    return NextResponse.json({ page_id: active.jobId, cached: false }, { status: 200 })
  }

  // Stale or new — run a fresh crawl.
  const id = randomUUID()
  await createJob(id, canonicalUrl)
  await bumpPageRequest(canonicalUrl)
  if (user) await upsertUserRequest(user.id, canonicalUrl)
  waitUntil(runCrawlPipeline(id, canonicalUrl))

  return NextResponse.json({ page_id: id, cached: false }, { status: 201 })
}
