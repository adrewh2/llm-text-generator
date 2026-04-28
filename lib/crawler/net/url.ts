import { isForbiddenIpv4, isForbiddenIpv6 } from "./ipRanges"

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
    if (/^\/(user|users|u|profile|profiles|member|members)\//.test(path)) return true
    // Fused-@ handles (Twitter, Medium, Mastodon, TikTok, Threads): the
    // real-world form is `/@username`, not `/@/username`. A single char
    // after `@` is enough to qualify — no trailing slash required.
    if (/^\/@[^/]/.test(path)) return true

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
  // Group by prefix, then within each bucket prefer shorter paths
  // (the section index over individual leaf pages). When the sitemap
  // happens to list /about/board-directors/john-doe before
  // /about/board-directors/, naive first-N capping would keep the
  // person and drop the index — and the index is what tells an LLM
  // reader what the section is. Sorting by depth ascending wins back
  // the slot.
  const buckets = new Map<string, Set<string>>()
  const unparseable: string[] = []
  for (const url of urls) {
    try {
      const segments = new URL(url).pathname.split("/").filter(Boolean)
      const prefix = segments.slice(0, segmentDepth).join("/") || "root"
      const set = buckets.get(prefix) ?? new Set<string>()
      set.add(url)
      buckets.set(prefix, set)
    } catch {
      unparseable.push(url)
    }
  }

  const kept = new Set<string>(unparseable)
  for (const set of buckets.values()) {
    const sorted = [...set].sort((a, b) => pathDepthFor(a) - pathDepthFor(b))
    for (let i = 0; i < Math.min(maxPerPrefix, sorted.length); i++) {
      kept.add(sorted[i])
    }
  }

  // Preserve the caller's original ordering in the returned array —
  // downstream stages assume "earlier = more important" when the LLM
  // ranker isn't available — and emit each kept URL at most once,
  // even if the input contained duplicates.
  const seen = new Set<string>()
  const out: string[] = []
  for (const url of urls) {
    if (kept.has(url) && !seen.has(url)) {
      seen.add(url)
      out.push(url)
    }
  }
  return out
}

function pathDepthFor(url: string): number {
  try {
    return new URL(url).pathname.split("/").filter(Boolean).length
  } catch {
    return Infinity
  }
}

/**
 * Drop parametric fan-out — entire first-path-segment prefixes that
 * contain many templated leaf URLs (one entry per city / store /
 * listing / location-slug / product-id). The parent index page
 * (depth-1, e.g. /location, /store) survives in a different first-
 * segment bucket. An LLM consumer of llms.txt wants to know the
 * directory exists and where to find it — not to ingest every entry.
 *
 * Detection uses two signals together: a first-segment subtree is
 * fan-out when BOTH (a) total URLs under it ≥ threshold (lots of
 * stuff under one prefix), AND (b) distinct second-segment values
 * ≥ max(8, threshold/2) (the variation looks parametric — one per
 * city / store / id — not a small set of categories). The second
 * signal is what lets a deep docs hierarchy survive: a /docs/ subtree
 * might have 60+ leaf URLs but typically only 3–5 distinct depth-2
 * categories (auth, api, payments), which fails the distinct-second
 * check.
 *
 * Counting total URLs (instead of just depth-2 leaves) catches deep
 * fan-out shapes like /cities/{city}/venues/{slug} where the depth-2
 * city index pages aren't in the candidate list. The original
 * "depth-2 only" rule missed those because depth-2 count was 0.
 *
 * When a first segment triggers, every URL under it (any depth) is
 * dropped — deeper children of a fan-out section are also fan-out.
 * Depth-1 URLs (the index pages themselves) are never candidates for
 * being dropped here.
 *
 * Detection is purely structural (URL count + segment cardinality,
 * no hardcoded section nouns) so it works across genres without
 * over-fitting to specific patterns.
 */
export function dropParametricFanout(urls: string[], threshold: number): string[] {
  const allUnderFirst = new Map<string, string[]>()
  const distinctSecondPerFirst = new Map<string, Set<string>>()
  for (const url of urls) {
    try {
      const segs = new URL(url).pathname.split("/").filter(Boolean)
      if (segs.length < 2) continue
      const first = segs[0]
      const second = segs[1]
      const list = allUnderFirst.get(first) ?? []
      list.push(url)
      allUnderFirst.set(first, list)
      const distinctSet = distinctSecondPerFirst.get(first) ?? new Set<string>()
      distinctSet.add(second)
      distinctSecondPerFirst.set(first, distinctSet)
    } catch {
      // Unparseable URLs aren't fan-out candidates.
    }
  }
  // Floor at 8 distinct second-segment values so a small site with
  // 6 blog categories × 4 posts each (~24 URLs total) doesn't trip
  // when threshold is small. Calibrated against the docs-hierarchy
  // test fixture (3 categories should never trip).
  const minDistinctSecond = Math.max(8, Math.floor(threshold / 2))
  const dropped = new Set<string>()
  for (const [first, list] of allUnderFirst) {
    const total = list.length
    const distinctSecond = distinctSecondPerFirst.get(first)?.size ?? 0
    if (total >= threshold && distinctSecond >= minDistinctSecond) {
      for (const u of list) dropped.add(u)
    }
  }
  return urls.filter((u) => !dropped.has(u))
}

export function isValidHttpUrl(url: string): boolean {
  try {
    const u = new URL(url)
    return u.protocol === "http:" || u.protocol === "https:"
  } catch {
    return false
  }
}

// Client-safe URL validation. Mirrors the DNS-independent subset of
// the server's SSRF guard (lib/crawler/ssrf.ts#assertSafeUrl) so the
// Landing form can disable the Generate button and surface a hint
// before any request is sent. Cannot detect DNS-level failures
// (hostnames that don't resolve) — the server remains authoritative.
export function clientValidateUrl(raw: string):
  | { ok: true }
  | { ok: false; reason: string } {
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return { ok: false, reason: "Enter a valid URL" }
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    return { ok: false, reason: "URL must start with http:// or https://" }
  }
  if (u.port !== "") {
    return { ok: false, reason: "Custom ports aren't allowed" }
  }
  const host = u.hostname
  if (!host) return { ok: false, reason: "Enter a valid hostname" }

  const lowered = host.toLowerCase()
  if (lowered === "localhost" || lowered.endsWith(".localhost")) {
    return { ok: false, reason: "localhost URLs aren't allowed" }
  }

  // IPv6 literals — `new URL().hostname` keeps the surrounding
  // brackets (per WHATWG URL), so strip them before classifying.
  // Detect via colon and validate against the shared ranges module.
  if (lowered.includes(":")) {
    const stripped = lowered.startsWith("[") && lowered.endsWith("]")
      ? lowered.slice(1, -1)
      : lowered
    if (isForbiddenIpv6(stripped)) {
      return { ok: false, reason: "Private or reserved IP ranges aren't allowed" }
    }
    return { ok: true }
  }
  // IPv4 literal
  if (/^\d+\.\d+\.\d+\.\d+$/.test(lowered)) {
    if (isForbiddenIpv4(lowered)) {
      return { ok: false, reason: "Private or reserved IP ranges aren't allowed" }
    }
    return { ok: true }
  }

  // Regular hostname — require at least one dot so single-word typos
  // (e.g. `asfpskdafj`) don't fall through to a DNS lookup that's
  // guaranteed to fail.
  if (!lowered.includes(".")) {
    return { ok: false, reason: "Enter a full domain (e.g. example.com)" }
  }
  return { ok: true }
}
