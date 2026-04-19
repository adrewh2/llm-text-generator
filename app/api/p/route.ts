import { NextRequest, NextResponse } from "next/server"
import { randomUUID } from "crypto"
import { waitUntil } from "@vercel/functions"
import { bumpPageRequest, createJob, getActiveJobForUrl, getPageByUrl, upsertUserRequest } from "@/lib/store"
import { altWwwForm, isValidHttpUrl, normalizeUrl } from "@/lib/crawler/net/url"
import { resolveCanonicalUrl } from "@/lib/crawler/net/canonicalUrl"
import { assertSafeUrl, UnsafeUrlError } from "@/lib/crawler/net/ssrf"
import { clientIp, consumeRateLimit, isAllowedOrigin } from "@/lib/upstash/rateLimit"
import { api, rateLimit } from "@/lib/config"
import { enqueueCrawl } from "@/lib/upstash/jobQueue"
import { getCurrentUser } from "@/lib/supabase/getUser"
import { errorLog } from "@/lib/log"

// Fire-and-forget wrapper around `waitUntil` that surfaces failures to
// Sentry via errorLog. Without the catch, a rejected background promise
// logs once via Vercel but doesn't land in our Issues feed.
function runAfterResponse(context: string, p: Promise<unknown>): void {
  waitUntil(
    p.catch((err) => errorLog(`api/p.${context}`, err instanceof Error ? err : new Error(String(err))))
  )
}

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

  // Up-front SSRF + reachability check. resolveCanonicalUrl()'s probe
  // swallows errors to fall back to the raw URL on flaky networks, so
  // without this gate an UnsafeUrlError (loopback, metadata IPs, non-
  // default ports, DNS-unresolvable hosts) silently leaks into the
  // pages table as a valid row.
  try {
    await assertSafeUrl(trimmed)
  } catch (err) {
    if (err instanceof UnsafeUrlError) {
      return NextResponse.json({ error: "URL is not reachable or not allowed." }, { status: 400 })
    }
    throw err
  }

  const user = await getCurrentUser()

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
  // bumpPageRequest fires best-effort; a flaky Supabase write
  // shouldn't turn a cache-hit into a 500 for the user.
  const tryServeAt = async (key: string): Promise<NextResponse | null> => {
    const existing = await getPageByUrl(key)
    if (existing && !existing.isStale) {
      // Defer both writes past the response — neither gates the
      // client's ability to navigate to /p/{id} and start polling.
      runAfterResponse("bumpPageRequest", bumpPageRequest(key))
      if (user) runAfterResponse("upsertUserRequest", upsertUserRequest(user.id, key))
      return NextResponse.json({ page_id: existing.pageId, cached: true }, { status: 200 })
    }
    const active = await getActiveJobForUrl(key)
    if (active) {
      runAfterResponse("bumpPageRequest", bumpPageRequest(key))
      if (user) runAfterResponse("upsertUserRequest", upsertUserRequest(user.id, key))
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

  // Stale or new — run a fresh crawl. createJob is the only write
  // that has to block the response: once it returns, the pages + jobs
  // rows exist so the client's immediate poll for /api/p/[id] finds
  // a row. Everything after is backgrounded via waitUntil so the
  // user navigates to /p/{id} without waiting on the QStash publish
  // (~200 ms) or two small DB writes (~100 ms) — ~500 ms saved on
  // the cache-miss hot path.
  //
  // Trade-off on ordering: the old code bumped last_requested_at AFTER
  // enqueueCrawl so a failed enqueue wouldn't mark the URL as
  // "actively requested". Under waitUntil they run concurrently, so a
  // failed enqueue can leave an active-looking last_requested_at on a
  // URL whose crawl never started. That's tolerable: `sweepStuckJobs`
  // in the monitor cron force-fails non-terminal jobs past 15 min,
  // and a failed job naturally ages out of monitoring after 5 days.
  // The returned `page_id` is the pages.id UUID — stable across every
  // future re-crawl of this URL.
  const jobId = randomUUID()
  const { pageId } = await createJob(jobId, canonicalUrl)
  runAfterResponse("enqueueCrawl", enqueueCrawl(jobId, canonicalUrl))
  runAfterResponse("bumpPageRequest", bumpPageRequest(canonicalUrl))
  if (user) runAfterResponse("upsertUserRequest", upsertUserRequest(user.id, canonicalUrl))

  return NextResponse.json({ page_id: pageId, cached: false }, { status: 201 })
}
