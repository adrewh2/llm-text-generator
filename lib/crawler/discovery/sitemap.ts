import { load } from "cheerio"
import { normalizeUrl } from "../net/url"
import { safeFetch } from "../net/safeFetch"
import { readBoundedText } from "../net/readBounded"
import { USER_AGENT } from "./fetchPage"
import { crawler } from "../../config"

const { MAX_SITEMAP_URLS, SITEMAP_TIMEOUT_MS, SITEMAP_MAX_BYTES } = crawler

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
    // safeFetch enforces SSRF per-hop — important because a sitemap
    // index can declare arbitrary cross-origin Sitemap: URLs.
    const res = await safeFetch(url, {
      signal: AbortSignal.timeout(SITEMAP_TIMEOUT_MS),
      headers: { "User-Agent": USER_AGENT },
    })
    if (!res.ok) return

    const contentType = res.headers.get("content-type") || ""
    if (!contentType.includes("xml") && !contentType.includes("text")) return

    // Stream with a cap — a multi-GB sitemap (or a misbehaving server
    // sending chunked content forever) would otherwise OOM us before
    // the XML parser is reached.
    const text = await readBoundedText(res, SITEMAP_MAX_BYTES)
    if (text === null) return
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

    // URL set — explicit loop so we can break cleanly when we hit the cap.
    const locs = $("url > loc").toArray()
    for (const el of locs) {
      if (collected.length >= MAX_SITEMAP_URLS) break
      const loc = $(el).text().trim()
      const normalized = normalizeUrl(loc)
      if (normalized) collected.push(normalized)
    }
  } catch {
    // Non-fatal
  }
}
