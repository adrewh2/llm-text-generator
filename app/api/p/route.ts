import { NextRequest, NextResponse } from "next/server"
import { randomUUID } from "crypto"
import { bumpPageRequest, createJob, getActiveJobForUrl, getPageByUrl, upsertUserRequest } from "@/lib/store"
import { isValidHttpUrl, normalizeUrl } from "@/lib/crawler/url"
import { safeFetch } from "@/lib/crawler/safeFetch"
import { clientIp, consumeRateLimit } from "@/lib/rateLimit"
import { api, rateLimit } from "@/lib/config"
import { enqueueCrawl } from "@/lib/jobQueue"
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

  // Resolve canonical URL. safeFetch enforces SSRF per-hop on the
  // redirect chain; normalizeUrl strips per-request session/OAuth
  // tokens (e.g. Google's dsh/ifkv/osid) so the cache key is stable
  // across resubmissions.
  //
  // To unify `www.foo.com` and `foo.com`, we probe both forms:
  // - If they resolve to the same URL, the server expressed a
  //   preference (e.g. speedtest.net → www.speedtest.net); honor it.
  // - If they resolve independently, no server preference exists
  //   (e.g. speedtest.com); strip `www.` as dedup convention.
  const probe = async (u: string): Promise<string> => {
    try {
      const res = await safeFetch(u, {
        method: "HEAD",
        signal: AbortSignal.timeout(5000),
      })
      return res.url || u
    } catch {
      return u
    }
  }
  const altWwwForm = (u: string): string | null => {
    try {
      const parsed = new URL(u)
      parsed.hostname = parsed.hostname.startsWith("www.")
        ? parsed.hostname.slice(4)
        : `www.${parsed.hostname}`
      return parsed.toString()
    } catch {
      return null
    }
  }
  const stripWww = (u: string): string => {
    try {
      const parsed = new URL(u)
      parsed.hostname = parsed.hostname.replace(/^www\./, "")
      return parsed.toString()
    } catch {
      return u
    }
  }

  const trimmed = url.trim()
  let canonicalUrl = trimmed
  const resolvedA = await probe(trimmed)
  const alt = altWwwForm(trimmed)
  if (alt) {
    const resolvedB = await probe(alt)
    const nA = normalizeUrl(resolvedA) || resolvedA
    const nB = normalizeUrl(resolvedB) || resolvedB
    canonicalUrl = nA === nB ? resolvedA : stripWww(resolvedA)
  } else {
    canonicalUrl = resolvedA
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

  // Stale or new — run a fresh crawl. Bump `last_requested_at` AFTER
  // the enqueue has been handed off so an enqueue that silently falls
  // back to the in-process path (or fails entirely) doesn't mark the
  // URL as "actively requested" for sweep purposes when nothing is
  // actually running.
  const id = randomUUID()
  await createJob(id, canonicalUrl)
  if (user) await upsertUserRequest(user.id, canonicalUrl)
  await enqueueCrawl(id, canonicalUrl)
  await bumpPageRequest(canonicalUrl)

  return NextResponse.json({ page_id: id, cached: false }, { status: 201 })
}
