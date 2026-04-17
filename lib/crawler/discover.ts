import { load } from "cheerio"
import { normalizeUrl, isSameDomain, shouldSkipUrl } from "./url"

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
