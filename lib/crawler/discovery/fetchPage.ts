import { UnsafeUrlError } from "../net/ssrf"
import { safeFetch } from "../net/safeFetch"
import { readBoundedText } from "../net/readBounded"
import { crawler } from "../../config"

const MAX_SIZE = crawler.RESPONSE_MAX_BYTES

// Real-Chrome UA + the cluster of client-hint and Sec-Fetch headers a
// real navigation sends. Bot WAFs (Akamai on tesla.com, for instance)
// 403 anything that announces itself as `LlmsTxtGenerator/...` even
// though the crawl is well-behaved (single request per page, honors
// robots.txt + Crawl-delay). Without this we get a degenerate 1-entry
// llms.txt for any site behind a major edge provider.
export const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"

export const BROWSER_HEADERS: Record<string, string> = {
  "User-Agent": USER_AGENT,
  Accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  "sec-ch-ua": '"Chromium";v="131", "Not_A Brand";v="24"',
  "sec-ch-ua-mobile": "?0",
  "sec-ch-ua-platform": '"macOS"',
  "Sec-Fetch-Dest": "document",
  "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-Site": "none",
  "Sec-Fetch-User": "?1",
  "Upgrade-Insecure-Requests": "1",
}

export interface FetchResult {
  ok: boolean
  status?: number
  html?: string
  error?: string
}

/**
 * True if the HTML body is a bot-challenge or access-denied page
 * rather than real content. These show up with 200 status (Cloudflare
 * JS challenge, for instance), so HTTP codes alone aren't enough.
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
      headers: BROWSER_HEADERS,
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
