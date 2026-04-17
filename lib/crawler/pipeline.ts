import { fetchRobots, isAllowed } from "./robots"
import { fetchSitemapUrls } from "./sitemap"
import { fetchPage } from "./fetchPage"
import { extractMetadata, extractSiteName } from "./extract"
import { probeMarkdown } from "./markdownProbe"
import { extractLinksFromHtml } from "./discover"
import { scorePages } from "./score"
import { assignSections, filterAndSelectPages } from "./group"
import { assembleFile } from "./assemble"
import { detectGenre } from "./genre"
import { normalizeUrl, isSameDomain, shouldSkipUrl } from "./url"
import { updateJob } from "../store"
import type { ExtractedPage } from "./types"

const MAX_PAGES = 25
const MAX_DEPTH = 2
const CONCURRENCY = 3
const POLITENESS_DELAY_MS = 600

export async function runCrawlPipeline(jobId: string, targetUrl: string): Promise<void> {
  try {
    await setStatus(jobId, "crawling")

    const baseUrl = normalizeUrl(targetUrl) || targetUrl

    // Fetch robots.txt
    const robots = await fetchRobots(baseUrl)

    // Seed queue with sitemap URLs
    const sitemapSources =
      robots.sitemaps.length > 0
        ? robots.sitemaps.slice(0, 3)
        : [
            new URL("/sitemap.xml", baseUrl).toString(),
            new URL("/sitemap_index.xml", baseUrl).toString(),
          ]

    const discoveredUrls = new Set<string>([baseUrl])
    const queue: Array<{ url: string; depth: number }> = []

    for (const sitemapUrl of sitemapSources) {
      const urls = await fetchSitemapUrls(sitemapUrl, baseUrl)
      for (const u of urls) {
        if (isSameDomain(u, baseUrl) && !shouldSkipUrl(u) && isAllowed(u, robots.disallowed)) {
          if (!discoveredUrls.has(u)) {
            discoveredUrls.add(u)
            queue.push({ url: u, depth: 1 })
          }
        }
      }
    }

    updateJob(jobId, {
      progress: { discovered: discoveredUrls.size, crawled: 0, failed: 0 },
    })

    // Crawl homepage first (required for genre detection and site name)
    const homepageFetch = await fetchPage(baseUrl)
    if (!homepageFetch.ok || !homepageFetch.html) {
      updateJob(jobId, {
        status: "failed",
        error: `Failed to fetch homepage: ${homepageFetch.error || "unknown error"}`,
      })
      return
    }

    const homepageHtml = homepageFetch.html
    const homepageMeta = extractMetadata(baseUrl, homepageHtml)
    const homepageMdUrl = await probeMarkdown(baseUrl)

    const pages: ExtractedPage[] = [
      { ...homepageMeta, mdUrl: homepageMdUrl || undefined, fetchStatus: "ok" },
    ]

    let crawled = 1
    let failed = 0
    const visited = new Set<string>([baseUrl])

    // Discover navigation links from homepage if sitemap was sparse
    if (queue.length < 5) {
      const navLinks = extractLinksFromHtml(homepageHtml, baseUrl)
      for (const link of navLinks) {
        if (!discoveredUrls.has(link) && isAllowed(link, robots.disallowed)) {
          discoveredUrls.add(link)
          queue.push({ url: link, depth: 1 })
        }
      }
    }

    updateJob(jobId, {
      progress: { discovered: discoveredUrls.size, crawled, failed },
    })

    // Prioritize high-value paths (docs, api, examples) before marketing pages
    queue.sort((a, b) => urlPriority(b.url) - urlPriority(a.url))

    // BFS with concurrency
    let queueIdx = 0
    while (crawled < MAX_PAGES && queueIdx < queue.length) {
      const batch: Array<{ url: string; depth: number }> = []
      while (batch.length < CONCURRENCY && queueIdx < queue.length && crawled + batch.length < MAX_PAGES) {
        const item = queue[queueIdx++]
        if (!visited.has(item.url)) batch.push(item)
      }
      if (batch.length === 0) continue

      await Promise.all(
        batch.map(async ({ url, depth }) => {
          if (visited.has(url)) return
          visited.add(url)

          await delay(POLITENESS_DELAY_MS + Math.random() * 200)

          const result = await fetchPage(url)
          if (!result.ok || !result.html) {
            failed++
            pages.push({
              url,
              title: urlToLabel(url),
              headings: [],
              fetchStatus: result.error === "Timeout" ? "timeout" : "error",
              descriptionProvenance: "none",
            })
            return
          }

          const meta = extractMetadata(url, result.html)
          const mdUrl = await probeMarkdown(url)
          pages.push({ ...meta, mdUrl: mdUrl || undefined, fetchStatus: "ok" })
          crawled++

          // Discover links at this depth
          if (depth < MAX_DEPTH) {
            const links = extractLinksFromHtml(result.html, baseUrl)
            for (const link of links) {
              if (!discoveredUrls.has(link) && isAllowed(link, robots.disallowed) && !shouldSkipUrl(link)) {
                discoveredUrls.add(link)
                queue.push({ url: link, depth: depth + 1 })
              }
            }
          }
        })
      )

      updateJob(jobId, {
        progress: { discovered: discoveredUrls.size, crawled, failed },
      })
    }

    // Detect genre + site name
    const genre = detectGenre(homepageHtml, [...discoveredUrls])
    const siteName = extractSiteName(homepageHtml, new URL(baseUrl).hostname)

    updateJob(jobId, { status: "scoring", genre, siteName })

    // Score, group, filter
    const successful = pages.filter((p) => p.fetchStatus === "ok")
    const scored = scorePages(successful, genre)
    const withSections = assignSections(scored, genre)
    const { primary, optional } = filterAndSelectPages(withSections)

    updateJob(jobId, { status: "assembling" })

    const result = assembleFile(siteName, primary, optional)

    const status = failed > 0 && failed >= crawled * 0.5 ? "partial" : "complete"

    updateJob(jobId, {
      status,
      result,
      pages: withSections,
      genre,
      siteName,
    })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unexpected error"
    updateJob(jobId, { status: "failed", error: message })
  }
}

function urlPriority(url: string): number {
  try {
    const path = new URL(url).pathname.toLowerCase()
    if (/\/docs?\/|\/api\/|\/reference\/|\/guide\/|\/tutorial\/|\/learn\//.test(path)) return 10
    if (/\/example|\/demo|\/sample|\/cookbook/.test(path)) return 8
    if (/\/changelog|\/release/.test(path)) return 6
    if (/\/blog\/|\/post\/|\/article\//.test(path)) return 4
    if (/\/about|\/pricing|\/support|\/faq/.test(path)) return 3
    return 5
  } catch {
    return 0
  }
}

function setStatus(jobId: string, status: string) {
  updateJob(jobId, { status: status as never })
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

function urlToLabel(url: string): string {
  try {
    const path = new URL(url).pathname
    const seg = path.split("/").filter(Boolean).pop() || path
    return seg.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())
  } catch {
    return url
  }
}
