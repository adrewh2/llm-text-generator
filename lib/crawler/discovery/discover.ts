import { load } from "cheerio"
import { normalizeUrl, isSameDomain, shouldSkipUrl } from "../net/url"

export function extractLinksFromHtml(html: string, baseUrl: string): string[] {
  const $ = load(html)
  const seen = new Set<string>()

  $("a[href]").each((_, el) => {
    const href = $(el).attr("href")
    if (!href || href.startsWith("mailto:") || href.startsWith("tel:")) return

    const normalized = normalizeUrl(href, baseUrl)
    if (!normalized) return
    if (!isSameDomain(normalized, baseUrl)) return
    if (shouldSkipUrl(normalized)) return

    seen.add(normalized)
  })

  return [...seen]
}

/**
 * Pull external (cross-origin) anchors off the page, keeping the
 * first anchor text we see per URL. Used to surface the site's own
 * outbound references — spec links, canonical library docs, related
 * projects — as `llms.txt` entries, rather than filtering them out
 * the way `extractLinksFromHtml` does for crawl-discovery.
 *
 * We don't follow these links further; they're fetched exactly once
 * for metadata, then embedded verbatim.
 */
export interface ExternalLink {
  url: string
  anchor: string
}

export function extractExternalLinksFromHtml(
  html: string,
  baseUrl: string,
): ExternalLink[] {
  const $ = load(html)
  const seen = new Map<string, string>()

  $("a[href]").each((_, el) => {
    const href = $(el).attr("href")
    if (!href) return
    if (href.startsWith("mailto:") || href.startsWith("tel:") || href.startsWith("#")) return

    const normalized = normalizeUrl(href, baseUrl)
    if (!normalized) return
    if (!/^https?:\/\//i.test(normalized)) return
    if (isSameDomain(normalized, baseUrl)) return

    // Anchor text is attacker-controlled — the downstream LLM ranker
    // runs it through neuter(). Cap length here to keep the prompt
    // bounded even before that.
    const anchor = $(el).text().replace(/\s+/g, " ").trim().slice(0, 120)
    if (!seen.has(normalized)) seen.set(normalized, anchor)
  })

  return [...seen.entries()].map(([url, anchor]) => ({ url, anchor }))
}
