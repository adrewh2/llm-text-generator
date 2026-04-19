import { NextRequest, NextResponse } from "next/server"
import { randomUUID } from "crypto"
import { bumpPageRequest, createJob, getActiveJobForUrl, getPageByUrl, upsertUserRequest } from "@/lib/store"
import { altWwwForm, isValidHttpUrl, normalizeUrl } from "@/lib/crawler/url"
import { resolveCanonicalUrl } from "@/lib/crawler/canonicalUrl"
import { clientIp, consumeRateLimit, isAllowedOrigin } from "@/lib/rateLimit"
import { api, rateLimit } from "@/lib/config"
import { enqueueCrawl } from "@/lib/jobQueue"
import { createClient } from "@/lib/supabase/server"

export const runtime = "nodejs"
export const maxDuration = 300

export async function POST(req: NextRequest) {
  if (!isAllowedOrigin(req)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }

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
  const trimmed = url.trim()
  if (!isValidHttpUrl(trimmed)) {
    return NextResponse.json({ error: "Invalid URL — must be http:// or https://" }, { status: 400 })
  }

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  // Two-bucket rate limiting. Keys are prefixed per-bucket so the
  // limiters never share Redis entries. SUBMIT is a loose abuse
  // floor charged on every POST — bounds how often the cheap path
  // (URL validation + HEAD probe + DB lookups) can run. NEW_CRAWL
  // is the tight quota charged only when a submission actually
  // dispatches a fresh crawl; see further down.
  const principal = user ? `user:${user.id}` : `ip:${clientIp(req)}`
  const submit = await consumeRateLimit(
    `submit:${principal}`,
    user ? rateLimit.AUTH_SUBMIT : rateLimit.ANON_SUBMIT,
  )
  if (!submit.allowed) {
    return NextResponse.json(
      {
        error: "Too many submissions — please slow down.",
        reason: "submit_flood",
        retryAfterSec: submit.retryAfterSec,
        signInPrompt: !user,
      },
      { status: 429, headers: { "Retry-After": String(submit.retryAfterSec) } },
    )
  }

  // Try to serve from cache / attach to an active job at `key`.
  // Returns a response if handled, null if the caller should continue.
  // `page_id` in the response is the pages.id UUID — stable across
  // re-crawls, so two users of the same URL land on the same /p/{id}.
  const tryServeAt = async (key: string): Promise<NextResponse | null> => {
    const existing = await getPageByUrl(key)
    if (existing && !existing.isStale) {
      await bumpPageRequest(key)
      if (user) await upsertUserRequest(user.id, key)
      return NextResponse.json({ page_id: existing.pageId, cached: true }, { status: 200 })
    }
    const active = await getActiveJobForUrl(key)
    if (active) {
      await bumpPageRequest(key)
      if (user) await upsertUserRequest(user.id, key)
      return NextResponse.json({ page_id: active.pageId, cached: false }, { status: 200 })
    }
    return null
  }

  // Pre-resolution cache check. Most cached URLs sit under one of the
  // two raw www/non-www forms of what the user submitted, so we can
  // usually serve cache hits without paying for the HEAD probes.
  const rawKey = normalizeUrl(trimmed) || trimmed
  const altKey = normalizeUrl(altWwwForm(trimmed)) || trimmed
  const preKeys = rawKey === altKey ? [rawKey] : [rawKey, altKey]
  for (const key of preKeys) {
    const res = await tryServeAt(key)
    if (res) return res
  }

  // Miss on both raw forms — resolve the canonical URL via dual HEAD
  // probe. safeFetch enforces SSRF per-hop on the redirect chain;
  // normalizeUrl strips per-request session/OAuth tokens (e.g.
  // Google's dsh/ifkv/osid) so the cache key is stable across
  // resubmissions.
  const canonicalUrl = normalizeUrl(await resolveCanonicalUrl(trimmed)) || trimmed

  // Post-resolution cache check — only needed if the canonical URL
  // differs from the raw forms we already tried (e.g. the server
  // redirected to a different hostname like `auth.foo.com/login`).
  if (!preKeys.includes(canonicalUrl)) {
    const res = await tryServeAt(canonicalUrl)
    if (res) return res
  }

  // About to dispatch a fresh crawl — this is the expensive path, so
  // charge the tight new-crawl bucket. A denial here leaves the
  // submit bucket already ticked (the user did submit), which is
  // fine: cache-hit URLs remain available until the new-crawl
  // window refills.
  const newCrawl = await consumeRateLimit(
    `newcrawl:${principal}`,
    user ? rateLimit.AUTH_NEW_CRAWL : rateLimit.ANON_NEW_CRAWL,
  )
  if (!newCrawl.allowed) {
    return NextResponse.json(
      {
        error: "You've hit your limit for generating new pages.",
        reason: "new_crawl_quota",
        retryAfterSec: newCrawl.retryAfterSec,
        signInPrompt: !user,
      },
      { status: 429, headers: { "Retry-After": String(newCrawl.retryAfterSec) } },
    )
  }

  // Stale or new — run a fresh crawl. Bump `last_requested_at` AFTER
  // the enqueue has been handed off so an enqueue that silently falls
  // back to the in-process path (or fails entirely) doesn't mark the
  // URL as "actively requested" for sweep purposes when nothing is
  // actually running. The returned `page_id` is the pages.id UUID —
  // stable across every future re-crawl of this URL.
  const jobId = randomUUID()
  const { pageId } = await createJob(jobId, canonicalUrl)
  if (user) await upsertUserRequest(user.id, canonicalUrl)
  await enqueueCrawl(jobId, canonicalUrl)
  await bumpPageRequest(canonicalUrl)

  return NextResponse.json({ page_id: pageId, cached: false }, { status: 201 })
}
