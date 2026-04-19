// Query params that don't affect which *structural* page is shown.
// Stripping them at normalization time collapses same-page variants
// like /privacy?hl=en vs /privacy?hl=en-US into one.
const TRACKING_PARAMS = new Set([
  // Marketing / analytics
  "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content",
  "fbclid", "gclid", "msclkid", "_ga", "mc_cid", "mc_eid",
  "ref", "source", "from", "via",
  // Locale / geo — same page, different language
  "hl", "gl", "lang", "locale", "lng", "ln",
  // OAuth / redirect flow params — same landing page, different post-auth target
  "continue", "followup", "passive", "ec",
  "flowname", "flowentry", "service", "state",
  "redirect_uri", "redirect_url", "return_url", "returnurl", "returnto", "next",
  // Google session identifiers — per-request tokens that expire and
  // otherwise poison the cache key.
  "dsh", "emr", "osid", "ifkv",
])

const SKIP_EXTENSIONS = new Set([
  ".jpg", ".jpeg", ".png", ".gif", ".svg", ".webp", ".ico",
  ".pdf", ".zip", ".gz", ".tar", ".mp4", ".mp3", ".wav",
  ".woff", ".woff2", ".ttf", ".eot",
  ".css", ".js", ".map",
])

const SKIP_PATH_SEGMENTS = [
  "/cdn-cgi/", "/wp-login", "/wp-admin", "/wp-json",
  "/.well-known/", "/feed", "/rss", "/atom",
]

// Query params that signal individual content items, not structural pages
const CONTENT_ID_PARAMS = ["v", "id", "postid", "p", "article_id", "video_id"]

export function normalizeUrl(url: string, base?: string): string | null {
  try {
    const u = new URL(url, base)
    if (u.protocol !== "http:" && u.protocol !== "https:") return null

    u.hash = ""
    u.hostname = u.hostname.toLowerCase()
    // Strip userinfo — a submission of `https://alice:sekret@target.com`
    // would otherwise forward credentials on every crawl fetch, land
    // them in runtime logs + the QStash message body, and fork the
    // cache key off the principal's secret.
    u.username = ""
    u.password = ""

    // Strip trailing slash on any non-root path so "/docs" and
    // "/docs/" don't become two cache keys.
    if (u.pathname !== "/" && u.pathname.endsWith("/")) {
      u.pathname = u.pathname.replace(/\/+$/, "")
    }

    for (const key of [...u.searchParams.keys()]) {
      if (TRACKING_PARAMS.has(key.toLowerCase())) {
        u.searchParams.delete(key)
      }
    }

    return u.toString()
  } catch {
    return null
  }
}

// Flips the `www.` prefix: `foo.com` ↔ `www.foo.com`. Assumes the
// input already parses as a URL (callers validate via isValidHttpUrl).
export function altWwwForm(urlStr: string): string {
  const u = new URL(urlStr)
  u.hostname = u.hostname.startsWith("www.")
    ? u.hostname.slice(4)
    : `www.${u.hostname}`
  return u.toString()
}

export function isSameDomain(url: string, base: string): boolean {
  try {
    const u = new URL(url)
    const b = new URL(base)
    // Lowercase both sides — `normalizeUrl` lowercases hostnames on
    // its way into the queue, but this helper is also called from
    // places that hand in raw, mixed-case input (link extraction,
    // sitemap entries). Without this, `Example.com` vs `example.com`
    // would falsely classify as cross-origin.
    const uHost = u.hostname.toLowerCase().replace(/^www\./, "")
    const bHost = b.hostname.toLowerCase().replace(/^www\./, "")
    return uHost === bHost
  } catch {
    return false
  }
}

export function shouldSkipUrl(url: string): boolean {
  try {
    const u = new URL(url)
    const path = u.pathname.toLowerCase()

    // File extension check
    const ext = path.match(/\.([a-z0-9]+)(?:\?|$)/)
    if (ext && SKIP_EXTENSIONS.has(`.${ext[1]}`)) return true

    // Known boilerplate path segments
    if (SKIP_PATH_SEGMENTS.some((s) => path.includes(s))) return true

    // Pagination
    if (/\/page\/\d+/.test(path)) return true
    if (u.searchParams.has("page") && !path.includes("/docs")) return true

    // Print/export
    if (u.searchParams.has("print") || path.includes("/print/")) return true

    // Tag/category/author archive pages
    if (/\/(tag|category|author|archive)\//.test(path)) return true

    // Individual content item signals in query string
    // e.g. youtube.com/watch?v=abc123, ?id=12345
    for (const param of CONTENT_ID_PARAMS) {
      const val = u.searchParams.get(param)
      if (val && val.length >= 6) return true
    }

    // UUID in path (e.g. /posts/3f2504e0-4f89-11d3-9a0c-0305e82c3301)
    if (/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(path)) return true

    // Long numeric ID segment (6+ digits) — individual content items, not structure
    if (/\/\d{6,}(\/|$)/.test(path)) return true

    // User/profile paths
    if (/^\/(user|users|u|profile|profiles|@|member|members)\//.test(path)) return true

    // Short-form video or individual content paths (e.g. /shorts/, /clip/, /reel/)
    if (/\/(shorts|clips?|reels?|watch)\b/.test(path)) return true

    return false
  } catch {
    return true
  }
}

/**
 * Caps URLs per path prefix so a single section of the site can't
 * flood the queue (e.g. 500 /watch URLs on YouTube). Tunable via
 * config.crawler.URLS_PER_PREFIX_CAP and config.crawler.PREFIX_SEGMENT_DEPTH.
 */
export function capByPathPrefix(
  urls: string[],
  maxPerPrefix: number,
  segmentDepth: number,
): string[] {
  const prefixCounts = new Map<string, number>()
  const result: string[] = []

  for (const url of urls) {
    try {
      const segments = new URL(url).pathname.split("/").filter(Boolean)
      // Take the first `segmentDepth` segments as the bucket key.
      // e.g. depth=2 → "/docs/api/users" → "docs/api"
      const prefix = segments.slice(0, segmentDepth).join("/") || "root"
      const count = prefixCounts.get(prefix) ?? 0
      if (count < maxPerPrefix) {
        prefixCounts.set(prefix, count + 1)
        result.push(url)
      }
    } catch {
      result.push(url)
    }
  }

  return result
}

export function isValidHttpUrl(url: string): boolean {
  try {
    const u = new URL(url)
    return u.protocol === "http:" || u.protocol === "https:"
  } catch {
    return false
  }
}
