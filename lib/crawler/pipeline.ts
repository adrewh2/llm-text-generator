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

    // Fetch homepage with plain HTTP first to detect SPA. If it fails
    // (bot-block, 4xx, timeout), fall through to the Puppeteer path
    // below — claude.ai and similar sites 403 against a plain fetch but
    // render fine in a real browser.
    const homepageFetch = await fetchPage(baseUrl)
    const rawHomepageHtml = homepageFetch.ok ? homepageFetch.html ?? null : null
    const rawHomepageMeta = rawHomepageHtml ? extractMetadata(baseUrl, rawHomepageHtml) : null

    // Trigger the SPA (Puppeteer) path if either: plain fetch failed, or
    // the returned HTML looks like a JS shell / bot-challenge.
    const plainFetchFailed = rawHomepageHtml === null
    const isSpa = !plainFetchFailed && isSpaHtml(rawHomepageHtml!, rawHomepageMeta?.bodyExcerpt || "")
    const needsBrowser = plainFetchFailed || isSpa
    console.log(`[pipeline] plainFetchFailed=${plainFetchFailed} isSpa=${isSpa} bodyExcerptLen=${rawHomepageMeta?.bodyExcerpt?.length ?? 0} htmlLen=${rawHomepageHtml?.length ?? 0}`)
    if (needsBrowser) await spaBrowser.init()

    // Try the browser render as our homepage source when needed.
    let homepageHtml = rawHomepageHtml
    let homepageMeta = rawHomepageMeta
    if (needsBrowser) {
      const rendered = await spaBrowser.fetchPageWithLinks(baseUrl, baseUrl)
      console.log(`[pipeline] browser render ok=${rendered.ok} links=${rendered.links.length}`)
      if (rendered.ok && rendered.html) {
        homepageHtml = rendered.html
        homepageMeta = extractMetadata(baseUrl, homepageHtml)
        for (const link of rendered.links) {
          if (!discoveredUrls.has(link) && isAllowed(link, robots.disallowed)) {
            discoveredUrls.add(link)
            queue.push({ url: link, depth: 1 })
          }
        }
      }
    }

    if (!homepageHtml || !homepageMeta) {
      await updateJob(jobId, {
        status: "failed",
        error: `Failed to fetch homepage: ${homepageFetch.error || "browser render failed"}`,
      })
      return
    }

    const [homepageMdUrl] = await Promise.all([probeMarkdown(baseUrl)])
    const pages: ExtractedPage[] = [
      { ...homepageMeta, mdUrl: homepageMdUrl || undefined, fetchStatus: "ok" },
    ]

    let crawled = 1
    let failed = 0
    const visited = new Set<string>([baseUrl])

    // Discover navigation links from homepage if sitemap was sparse (non-SPA path)
    if (!needsBrowser && queue.length < 5) {
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

    // LLM ranking: intelligently select the most valuable URLs to crawl.
    // Preserve the LLM's output order — it has the full site context
    // (name, genre, homepage excerpt, complete URL set) and is better
    // placed to set priority than a path-based regex. The path regex
    // survives only as a tiebreaker below.
    const siteName0 = extractSiteName(homepageHtml, new URL(baseUrl).hostname)
    const homepageExcerpt = homepageMeta.bodyExcerpt || ""
    const rankedUrls = await rankCandidateUrls(
      queue.map((q) => q.url),
      siteName0,
      homepageExcerpt,
    )
    const urlToItem = new Map(queue.map((q) => [q.url, q]))
    const reordered = rankedUrls
      .map((u) => urlToItem.get(u))
      .filter((q): q is { url: string; depth: number } => !!q)
    queue.splice(0, queue.length, ...reordered)

    console.log(`[pipeline] queue after capping+ranking: ${queue.length} urls`)
    queue.slice(0, 5).forEach(q => console.log(`  ${q.url}`))

    await updateJob(jobId, {
      progress: { discovered: discoveredUrls.size, crawled, failed },
    })

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
        if (!needsBrowser) await delay(POLITENESS_DELAY_MS + Math.random() * 100)

        let html: string | null = null
        let links: string[] = []
        let mdUrlResolved: string | null = null

        if (needsBrowser) {
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
          const mdUrl = needsBrowser ? await probeMarkdown(url) : mdUrlResolved
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

    await Promise.all(Array.from({ length: needsBrowser ? 1 : CONCURRENCY }, () => worker()))

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

    // "partial" fires when a meaningful majority of fetch attempts
    // failed. Use total attempts (not just successes) as the denominator
    // so small crawls don't trip on a single failure. Require at least
    // 5 attempts before the rule kicks in — a 2-page site with 1
    // timeout shouldn't read as "partial".
    const attempted = crawled + failed
    const successRate = attempted > 0 ? crawled / attempted : 0
    const status =
      crawled === 0                          ? "failed"
      : attempted >= 5 && successRate < 0.5  ? "partial"
      : "complete"

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
