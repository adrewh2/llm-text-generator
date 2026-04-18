// Shared URL → human-readable-label / filesystem-safe-name helpers.
// Used by assemble.ts, pipeline.ts, and the download route.

/** Path segments, excluding blanks and any /index.(html|php|aspx) file. */
export function urlPathSegments(url: string): string[] {
  try {
    return new URL(url).pathname
      .split("/")
      .filter((s) => s && !/^index\.(html?|php|aspx?)$/i.test(s))
  } catch {
    return []
  }
}

/** Readable title-case label from the deepest meaningful path segment. */
export function urlToLabel(url: string): string {
  const segs = urlPathSegments(url)
  const last = segs[segs.length - 1]
  if (!last) return ""
  return toLabel(last.replace(/\.[^.]+$/, ""))
}

/** Convert a path segment like `getting-started` to `Getting Started`. */
export function toLabel(segment: string): string {
  return segment
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim()
}

/**
 * Filesystem-safe filename derived from a URL: hostname + path
 * segments joined with "_", sanitized to [A-Za-z0-9._-], `.txt`
 * extension. Stable across calls so callers can dedupe collisions.
 */
export function urlToFilename(url: string): string {
  try {
    const u = new URL(url)
    const host = u.hostname.replace(/^www\./, "")
    const segs = urlPathSegments(url).map((s) => s.replace(/\.[^.]+$/, ""))
    const suffix = segs.length > 0 ? `_${segs.join("_")}` : ""
    const raw = `${host}${suffix}`
    const safe = raw.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/-+/g, "-")
    return `${safe}.txt`
  } catch {
    return `page-${Date.now()}.txt`
  }
}
