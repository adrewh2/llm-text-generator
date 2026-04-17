import { load } from "cheerio"
import { normalizeUrl } from "./url"

const MAX_SITEMAP_URLS = 500
const SITEMAP_TIMEOUT = 10000

export async function fetchSitemapUrls(sitemapUrl: string, baseUrl: string): Promise<string[]> {
  const urls: string[] = []
  await processSitemap(sitemapUrl, baseUrl, urls, 0)
  return urls
}

async function processSitemap(
  url: string,
  baseUrl: string,
  collected: string[],
  depth: number
): Promise<void> {
  if (depth > 2 || collected.length >= MAX_SITEMAP_URLS) return

  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(SITEMAP_TIMEOUT),
      headers: { "User-Agent": "LlmsTxtGenerator/1.0" },
    })
    if (!res.ok) return

    const contentType = res.headers.get("content-type") || ""
    if (!contentType.includes("xml") && !contentType.includes("text")) return

    const text = await res.text()
    const $ = load(text, { xmlMode: true })

    // Sitemap index
    const sitemapLocs = $("sitemap > loc")
    if (sitemapLocs.length > 0) {
      const subs = sitemapLocs.map((_, el) => $(el).text().trim()).get()
      for (const sub of subs.slice(0, 5)) {
        await processSitemap(sub, baseUrl, collected, depth + 1)
        if (collected.length >= MAX_SITEMAP_URLS) break
      }
      return
    }

    // URL set
    $("url > loc").each((_, el) => {
      if (collected.length >= MAX_SITEMAP_URLS) return false as unknown as void
      const loc = $(el).text().trim()
      const normalized = normalizeUrl(loc)
      if (normalized) collected.push(normalized)
    })
  } catch {
    // Non-fatal
  }
}
