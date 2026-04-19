import { UnsafeUrlError } from "../net/ssrf"
import { safeFetch } from "../net/safeFetch"
import { readBoundedText } from "../net/readBounded"
import { crawler } from "../../config"

const MAX_SIZE = crawler.RESPONSE_MAX_BYTES
export const USER_AGENT =
  "LlmsTxtGenerator/1.0 (+https://llm-text-generator.vercel.app)"

export interface FetchResult {
  ok: boolean
  status?: number
  html?: string
  error?: string
}

/**
 * True if the HTML body is a bot-challenge or access-denied page rather
 * than real content. These show up with 200 status (Cloudflare JS
 * challenge, for instance), so we can't rely on HTTP codes alone.
 */
export function isBlockedByChallenge(html: string): boolean {
  const lower = html.toLowerCase()

  // Cloudflare challenge markers
  if (
    lower.includes("cf-browser-verification") ||
    lower.includes("cf_chl_opt") ||
    lower.includes("__cf_chl_") ||
    (lower.includes("challenge-platform") && lower.includes("cloudflare"))
  ) return true

  // Title-based detection catches other providers (PerimeterX, Akamai,
  // DataDome) and generic "checking your browser" interstitials.
  const titleMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i)
  const title = titleMatch?.[1]?.trim().toLowerCase() ?? ""
  if (!title) return false
  return (
    /^just a moment\b/.test(title) ||
    /^attention required/.test(title) ||
    /^access denied/.test(title) ||
    /^please wait\b/.test(title) ||
    /^checking your browser/.test(title) ||
    /^you have been blocked/.test(title) ||
    /^please verify/.test(title)
  )
}

export async function fetchPage(url: string): Promise<FetchResult> {
  try {
    // safeFetch re-validates every redirect hop for SSRF.
    const res = await safeFetch(url, {
      signal: AbortSignal.timeout(8000),
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "text/html,application/xhtml+xml",
        "Accept-Language": "en-US,en;q=0.9",
      },
    })

    // Reject non-2xx responses even when they return HTML — otherwise
    // an error page (e.g. a 400/404 with a "Bad Request" HTML body) gets
    // treated as real content and ends up in the llms.txt output.
    if (!res.ok) {
      return { ok: false, status: res.status, error: `HTTP ${res.status}` }
    }

    const contentType = res.headers.get("content-type") || ""
    if (!contentType.includes("text/html") && !contentType.includes("application/xhtml")) {
      return { ok: false, status: res.status, error: "Not HTML" }
    }

    const contentLength = res.headers.get("content-length")
    if (contentLength && parseInt(contentLength) > MAX_SIZE) {
      return { ok: false, error: "Response too large" }
    }

    // Stream with a hard cap — the Content-Length header above may be
    // missing or a lie. `readBoundedText` aborts the body as soon as
    // the accumulated byte count crosses the cap.
    const html = await readBoundedText(res, MAX_SIZE)
    if (html === null) {
      return { ok: false, error: "Response too large" }
    }
    if (isBlockedByChallenge(html)) {
      return { ok: false, status: res.status, error: "Bot challenge page" }
    }
    return { ok: true, status: res.status, html }
  } catch (e: unknown) {
    if (e instanceof UnsafeUrlError) return { ok: false, error: e.message }
    const err = e as Error
    if (err?.name === "AbortError" || err?.name === "TimeoutError") {
      return { ok: false, error: "Timeout" }
    }
    return { ok: false, error: err?.message || "Fetch error" }
  }
}
