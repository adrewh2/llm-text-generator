import { fetchRobots, isAllowed, hasFullDisallow } from "./robots"
import { fetchSitemapUrls } from "./sitemap"
import { fetchPage } from "./fetchPage"
import { extractMetadata, extractSiteName } from "./extract"
import { probeMarkdown } from "./markdownProbe"
import { extractLinksFromHtml } from "./discover"
import { isSpaHtml, SpaBrowser } from "./spaCrawler"
import { scorePages } from "./score"
import { llmEnrichPages, generateSitePreamble, rankCandidateUrls } from "./llmEnrich"
import { assignSections, filterAndSelectPages } from "./group"
import { assembleFile } from "./assemble"
import { detectGenre } from "./genre"
import { normalizeUrl, isSameDomain, shouldSkipUrl, capByPathPrefix } from "./url"
import { updateJob } from "../store"
import type { ExtractedPage } from "./types"
import { MAX_PAGES, MAX_DEPTH, CONCURRENCY, POLITENESS_DELAY_MS } from "./config"

export async function runCrawlPipeline(jobId: string, targetUrl: string): Promise<void> {
  const spaBrowser = new SpaBrowser()

  try {
    await setStatus(jobId, "crawling")

    const baseUrl = normalizeUrl(targetUrl) || targetUrl

    // Fetch robots.txt
    const robots = await fetchRobots(baseUrl)
    const robotsFullBlock = hasFullDisallow(robots.disallowed)

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

    await updateJob(jobId, {
      progress: { discovered: discoveredUrls.size, crawled: 0, failed: 0 },
    })

    // Fetch homepage with plain HTTP first to detect SPA
    const homepageFetch = await fetchPage(baseUrl)
    if (!homepageFetch.ok || !homepageFetch.html) {
      await updateJob(jobId, {
        status: "failed",
        error: `Failed to fetch homepage: ${homepageFetch.error || "unknown error"}`,
      })
      return
    }

    const rawHomepageHtml = homepageFetch.html
    const rawHomepageMeta = extractMetadata(baseUrl, rawHomepageHtml)

    // Detect SPA / bot-challenge page — if so, use Puppeteer for the whole crawl
    const isSpa = isSpaHtml(rawHomepageHtml, rawHomepageMeta.bodyExcerpt || "")
    console.log(`[pipeline] isSpa=${isSpa} bodyExcerptLen=${rawHomepageMeta.bodyExcerpt?.length ?? 0} htmlLen=${rawHomepageHtml.length}`)
    if (isSpa) await spaBrowser.init()

    // Get real homepage content
    let homepageHtml = rawHomepageHtml
    let homepageMeta = rawHomepageMeta
    if (isSpa) {
      const rendered = await spaBrowser.fetchPageWithLinks(baseUrl, baseUrl)
      console.log(`[pipeline] SPA rendered ok=${rendered.ok} links=${rendered.links.length}`)
      if (rendered.ok) {
        homepageHtml = rendered.html
        homepageMeta = extractMetadata(baseUrl, homepageHtml)
        // Seed queue with rendered links
        for (const link of rendered.links) {
          if (!discoveredUrls.has(link) && isAllowed(link, robots.disallowed)) {
            discoveredUrls.add(link)
            queue.push({ url: link, depth: 1 })
          }
        }
      }
    }

    const [homepageMdUrl] = await Promise.all([probeMarkdown(baseUrl)])
    const pages: ExtractedPage[] = [
      { ...homepageMeta, mdUrl: homepageMdUrl || undefined, fetchStatus: "ok" },
    ]

    let crawled = 1
    let failed = 0
    const visited = new Set<string>([baseUrl])

    // Discover navigation links from homepage if sitemap was sparse (non-SPA path)
    if (!isSpa && queue.length < 5) {
      const navLinks = extractLinksFromHtml(homepageHtml, baseUrl)
      for (const link of navLinks) {
        if (!discoveredUrls.has(link) && isAllowed(link, robots.disallowed)) {
          discoveredUrls.add(link)
          queue.push({ url: link, depth: 1 })
        }
      }
    }

    // Cap URLs per path prefix to prevent content-heavy sites from flooding the queue
    const cappedUrls = capByPathPrefix(queue.map((q) => q.url), 5)
    const cappedSet = new Set(cappedUrls)
    queue.splice(0, queue.length, ...queue.filter((q) => cappedSet.has(q.url)))

    // LLM ranking: intelligently select the most valuable URLs to crawl
    const siteName0 = extractSiteName(homepageHtml, new URL(baseUrl).hostname)
    const homepageExcerpt = homepageMeta.bodyExcerpt || ""
    const rankedUrls = await rankCandidateUrls(
      queue.map((q) => q.url),
      siteName0,
      homepageExcerpt,
    )
    const rankedSet = new Set(rankedUrls)
    queue.splice(0, queue.length, ...queue.filter((q) => rankedSet.has(q.url)))

    console.log(`[pipeline] queue after capping+ranking: ${queue.length} urls`)
    queue.slice(0, 5).forEach(q => console.log(`  ${q.url}`))

    await updateJob(jobId, {
      progress: { discovered: discoveredUrls.size, crawled, failed },
    })

    // Prioritize high-value paths before marketing pages
    queue.sort((a, b) => urlPriority(b.url) - urlPriority(a.url))

    // Worker pool: each worker grabs the next URL as soon as it finishes,
    // no waiting for batch siblings. Safe in JS because sync code is atomic.
    let queueIdx = 0
    const worker = async (): Promise<void> => {
      while (crawled < MAX_PAGES) {
        let item: { url: string; depth: number } | undefined
        while (queueIdx < queue.length) {
          const candidate = queue[queueIdx++]
          if (!visited.has(candidate.url)) { item = candidate; break }
        }
        if (!item) break
        visited.add(item.url)

        const { url, depth } = item
        if (!isSpa) await delay(POLITENESS_DELAY_MS + Math.random() * 100)

        let html: string | null = null
        let links: string[] = []
        let mdUrlResolved: string | null = null

        if (isSpa) {
          const result = await spaBrowser.fetchPageWithLinks(url, baseUrl)
          if (result.ok) { html = result.html; links = result.links }
        } else {
          const [result, mdUrlResult] = await Promise.all([fetchPage(url), probeMarkdown(url)])
          if (result.ok && result.html) {
            html = result.html
            links = extractLinksFromHtml(result.html, baseUrl)
          }
          mdUrlResolved = mdUrlResult
        }

        if (!html) {
          failed++
          pages.push({ url, title: urlToLabel(url), headings: [], fetchStatus: "error", descriptionProvenance: "none" })
        } else if (crawled < MAX_PAGES) {
          const meta = extractMetadata(url, html)
          const mdUrl = isSpa ? await probeMarkdown(url) : mdUrlResolved
          pages.push({ ...meta, mdUrl: mdUrl || undefined, fetchStatus: "ok" })
          crawled++

          if (depth < MAX_DEPTH) {
            for (const link of links) {
              if (!discoveredUrls.has(link) && isAllowed(link, robots.disallowed) && !shouldSkipUrl(link)) {
                discoveredUrls.add(link)
                queue.push({ url: link, depth: depth + 1 })
              }
            }
          }
        }

        await updateJob(jobId, { progress: { discovered: discoveredUrls.size, crawled, failed } })
      }
    }

    await Promise.all(Array.from({ length: isSpa ? 1 : CONCURRENCY }, () => worker()))

    // Detect genre + site name
    const genre = detectGenre(homepageHtml, [...discoveredUrls])
    const siteName = extractSiteName(homepageHtml, new URL(baseUrl).hostname)

    // Strip pages whose description exactly matches the generic homepage tagline
    const homepageDesc = homepageMeta.description?.trim()
    const successful = pages
      .filter((p) => p.fetchStatus === "ok")
      .map((p) => {
        if (homepageDesc && p.url !== baseUrl && p.description?.trim() === homepageDesc) {
          return { ...p, description: undefined, descriptionProvenance: "none" as const }
        }
        return p
      })

    // LLM enrichment: classify pages and generate missing descriptions
    await updateJob(jobId, { status: "enriching", genre, siteName })
    const enrichment = await llmEnrichPages(successful, siteName, genre)

    await updateJob(jobId, { status: "scoring" })

    // Derive blockquote summary from homepage description
    const summary =
      homepageMeta.description && homepageMeta.descriptionProvenance !== "none"
        ? homepageMeta.description
        : undefined

    const scored = scorePages(successful, genre, enrichment)
    const withSections = assignSections(scored, genre)
    const { primary, optional } = filterAndSelectPages(withSections, baseUrl)

    // Deduplicate for display
    const seenUrls = new Set<string>()
    const dedupedSections = withSections.filter((p) => {
      if (seenUrls.has(p.url)) return false
      seenUrls.add(p.url)
      return true
    })

    await updateJob(jobId, { status: "assembling" })

    const preamble = await generateSitePreamble(siteName, genre, primary, optional)
    const robotsNotice = robotsFullBlock
      ? "Note: This site's robots.txt disallows all crawling (Disallow: /). Only the homepage could be indexed; the full site structure may not be represented here."
      : undefined
    const result = assembleFile(siteName, primary, optional, summary, preamble, robotsNotice)

    const status = failed > 0 && failed >= crawled * 0.5 ? "partial" : "complete"

    await updateJob(jobId, {
      status,
      result,
      pages: dedupedSections,
      genre,
      siteName,
    })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unexpected error"
    await updateJob(jobId, { status: "failed", error: message })
  } finally {
    await spaBrowser.close()
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

async function setStatus(jobId: string, status: string) {
  await updateJob(jobId, { status: status as never })
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
