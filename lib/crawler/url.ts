const TRACKING_PARAMS = new Set([
  "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content",
  "fbclid", "gclid", "msclkid", "_ga", "mc_cid", "mc_eid",
  "ref", "source", "from", "via",
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

export function normalizeUrl(url: string, base?: string): string | null {
  try {
    const u = new URL(url, base)
    if (u.protocol !== "http:" && u.protocol !== "https:") return null

    u.hash = ""
    u.hostname = u.hostname.toLowerCase()

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

export function isSameDomain(url: string, base: string): boolean {
  try {
    const u = new URL(url)
    const b = new URL(base)
    // Allow www/non-www variants
    const uHost = u.hostname.replace(/^www\./, "")
    const bHost = b.hostname.replace(/^www\./, "")
    return uHost === bHost
  } catch {
    return false
  }
}

export function shouldSkipUrl(url: string): boolean {
  try {
    const u = new URL(url)
    const path = u.pathname.toLowerCase()

    const ext = path.match(/\.([a-z0-9]+)(?:\?|$)/)
    if (ext && SKIP_EXTENSIONS.has(`.${ext[1]}`)) return true

    if (SKIP_PATH_SEGMENTS.some((s) => path.includes(s))) return true

    // Skip pagination
    if (/\/page\/\d+/.test(path)) return true
    if (u.searchParams.has("page") && !path.includes("/docs")) return true

    // Skip print/export
    if (u.searchParams.has("print") || path.includes("/print/")) return true

    // Skip tag/category/author archive pages
    if (/\/(tag|category|author|archive)\//.test(path)) return true

    return false
  } catch {
    return true
  }
}

export function isValidHttpUrl(url: string): boolean {
  try {
    const u = new URL(url)
    return u.protocol === "http:" || u.protocol === "https:"
  } catch {
    return false
  }
}
