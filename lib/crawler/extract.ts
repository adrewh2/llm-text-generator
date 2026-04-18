import { load, type CheerioAPI } from "cheerio"
import type { DescriptionProvenance, ExtractedPage } from "./types"

export function extractMetadata(
  url: string,
  html: string
): Omit<ExtractedPage, "mdUrl" | "fetchStatus"> {
  const $ = load(html)

  // Remove boilerplate before extraction
  $("script, style, noscript").remove()

  const title = extractTitle($) || urlToTitle(url)
  const canonical = $('link[rel="canonical"]').attr("href") || undefined
  const lang = $("html").attr("lang") || undefined
  const { description, provenance } = extractDescription($)
  const headings = extractHeadings($)
  const bodyExcerpt = extractExcerpt($)

  return {
    url: canonical ? resolveUrl(canonical, url) : url,
    title,
    description,
    bodyExcerpt,
    headings,
    lang,
    canonical: canonical ? resolveUrl(canonical, url) : undefined,
    descriptionProvenance: provenance,
  }
}

function extractTitle($: CheerioAPI): string {
  const og = $('meta[property="og:title"]').attr("content")?.trim()
  if (og) return cleanTitle(og)

  const tag = $("title").text().trim()
  if (tag) return cleanTitle(tag)

  const h1 = $("h1").first().text().trim()
  if (h1) return cleanTitle(h1)

  return ""
}

// Titles often have a site-name suffix like "Page — Site Name" that we
// want to strip. Be conservative: only strip if the suffix starts with
// a word character (a capital letter is a stronger signal but e.g.
// lowercase site names exist). We never strip em/en dashes that are
// inside a longer sentence — require at least a leading space+sep.
function cleanTitle(t: string): string {
  return t
    // "Quick start | Next.js Docs" → "Quick start"
    .replace(/\s+[|·•]\s+[^|·•]{1,60}$/, "")
    // "Quick start - Next.js" → "Quick start" (only when the suffix
    // looks like a site / product name: starts with a letter, no
    // trailing punctuation). Guard against en/em dashes to preserve
    // titles like "React — A JS Library".
    .replace(/\s+-\s+\w[^-]{0,40}$/, "")
    .replace(/\s*(Home|Homepage|Welcome|Official Site|Official Website)\s*$/i, "")
    .trim()
    || t.trim()
}

function extractDescription($: CheerioAPI): {
  description?: string
  provenance: DescriptionProvenance
} {
  // JSON-LD
  const jld = extractJsonLdDescription($)
  if (jld) return { description: jld, provenance: "json_ld" }

  // og:description
  const og = $('meta[property="og:description"]').attr("content")?.trim()
  if (og && og.length > 20) return { description: og, provenance: "og" }

  // meta description
  const meta = $('meta[name="description"]').attr("content")?.trim()
  if (meta && meta.length > 20) return { description: meta, provenance: "meta" }

  // First sentence of excerpt
  const excerpt = extractExcerpt($)
  if (excerpt) {
    const first = excerpt.match(/[^.!?\n]{20,}[.!?]/)?.[0]?.trim()
    if (first && first.length > 20 && first.length < 300) {
      return { description: first, provenance: "excerpt" }
    }
  }

  // h2 fallback
  const h2 = $("h2").first().text().trim()
  if (h2 && h2.length > 10 && h2.length < 200) {
    return { description: h2, provenance: "heading" }
  }

  return { provenance: "none" }
}

function extractJsonLdDescription($: CheerioAPI): string | null {
  const scripts = $('script[type="application/ld+json"]')
  for (let i = 0; i < scripts.length; i++) {
    try {
      const raw = $(scripts[i]).html() || ""
      const data = JSON.parse(raw)
      const items = Array.isArray(data["@graph"]) ? data["@graph"] : [data]
      for (const item of items) {
        if (typeof item.description === "string" && item.description.length > 20) {
          return item.description
        }
      }
    } catch {}
  }
  return null
}

function extractHeadings($: CheerioAPI): string[] {
  const headings: string[] = []
  $("h1, h2, h3")
    .slice(0, 10)
    .each((_, el) => {
      const text = $(el).text().trim()
      if (text && !headings.includes(text)) headings.push(text)
    })
  return headings
}

// Cap excerpt at roughly 4 KB of UTF-8 so a malicious site serving a
// wall of 4-byte Unicode can't inflate what we store in pages.crawled_pages.
const MAX_EXCERPT_BYTES = 4096

function extractExcerpt($: CheerioAPI): string {
  const main = $("main, article, [role='main'], .content, .post-content, #content, .entry-content").first()
  const source = main.length ? main : $("body")

  const raw = source
    .clone()
    .find("script, style, nav, footer, header, form, .sidebar, .menu, .nav, .cookie, .banner")
    .remove()
    .end()
    .text()
    .replace(/\s+/g, " ")
    .trim()

  return truncateBytes(raw, MAX_EXCERPT_BYTES)
}

// Slice a string so its UTF-8 byte length doesn't exceed `maxBytes`,
// without splitting a multi-byte codepoint.
function truncateBytes(s: string, maxBytes: number): string {
  const encoder = new TextEncoder()
  if (encoder.encode(s).length <= maxBytes) return s
  // Binary search on character length.
  let lo = 0, hi = s.length
  while (lo < hi) {
    const mid = (lo + hi + 1) >>> 1
    if (encoder.encode(s.slice(0, mid)).length <= maxBytes) lo = mid
    else hi = mid - 1
  }
  return s.slice(0, lo)
}

export function extractSiteName(html: string, hostname: string): string {
  const $ = load(html)

  const ogSite = $('meta[property="og:site_name"]').attr("content")?.trim()
  // Skip og:site_name if it looks like a hostname (e.g. "fastht.ml", "example.com")
  if (ogSite && !looksLikeHostname(ogSite, hostname)) return ogSite

  const appName = $('meta[name="application-name"]').attr("content")?.trim()
  if (appName) return appName

  // JSON-LD
  const scripts = $('script[type="application/ld+json"]')
  for (let i = 0; i < scripts.length; i++) {
    try {
      const data = JSON.parse($(scripts[i]).html() || "{}")
      const name = data.name || data.publisher?.name
      if (name && typeof name === "string" && name.length < 80) return name
    } catch {}
  }

  const title = $("title").text().trim()
  if (title) {
    const cleaned = cleanTitle(title)
    if (cleaned) return cleaned
  }

  const h1 = $("h1").first().text().trim()
  if (h1 && h1.length < 80) return h1

  // Fallback: capitalize hostname
  return hostname
    .replace(/^www\./, "")
    .split(".")[0]
    .replace(/-/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase())
}

function looksLikeHostname(value: string, hostname: string): boolean {
  const norm = value.toLowerCase()
  const host = hostname.toLowerCase().replace(/^www\./, "")
  // Exact hostname match
  if (norm === host || norm === `www.${host}`) return true
  // Matches the base domain (e.g. "fastht.ml" for hostname "www.fastht.ml")
  if (host.endsWith(norm) || norm.endsWith(host)) return true
  // Looks like a bare domain: letters/hyphens, dot, 2-6 char TLD
  if (/^[\w-]+\.[a-z]{2,6}$/.test(norm)) return true
  return false
}

function resolveUrl(url: string, base: string): string {
  try {
    return new URL(url, base).toString()
  } catch {
    return url
  }
}

function urlToTitle(url: string): string {
  try {
    const path = new URL(url).pathname
    const segments = path.split("/").filter(Boolean)
    const last = segments[segments.length - 1] || ""
    return last
      .replace(/[-_]/g, " ")
      .replace(/\.[^.]+$/, "")
      .replace(/\b\w/g, (c) => c.toUpperCase()) || url
  } catch {
    return url
  }
}
