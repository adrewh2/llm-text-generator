import { fetchRobots, isAllowed, hasFullDisallow } from "./discovery/robots"
import { fetchSitemapUrls } from "./discovery/sitemap"
import { fetchPage } from "./discovery/fetchPage"
import { extractMetadata, extractSiteName, extractSiteNameCandidates } from "./enrich/extract"
import { probeMarkdown } from "./discovery/markdownProbe"
import { extractLinksFromHtml, extractExternalLinksFromHtml } from "./discovery/discover"
import { isSpaHtml, SpaBrowser } from "./discovery/spaCrawler"
import { scorePages } from "./enrich/score"
import { llmEnrichPages, generateSitePreamble, rankCandidateUrls, rankExternalReferences, llmSiteName } from "./enrich/llmEnrich"
import { assignSections, filterAndSelectPages } from "./enrich/group"
import { assembleFile } from "./output/assemble"
import { detectGenre } from "./enrich/genre"
import { normalizeUrl, isSameDomain, shouldSkipUrl, capByPathPrefix } from "./net/url"
import { updateJob } from "../store"
import type { ExtractedPage } from "./types"
import { crawler } from "../config"
import { assertSafeUrl, UnsafeUrlError } from "./net/ssrf"

const {
  MAX_PAGES, MAX_DEPTH, CONCURRENCY, POLITENESS_DELAY_MS,
  PIPELINE_BUDGET_MS, URLS_PER_PREFIX_CAP, PREFIX_SEGMENT_DEPTH,
  EXTERNAL_REFS_MAX_KEEP, MAX_CRAWL_DELAY_MS,
} = crawler

class PipelineTimeoutError extends Error {
  constructor() { super("Exceeded time budget") }
}

export async function runCrawlPipeline(jobId: string, targetUrl: string): Promise<void> {
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => reject(new PipelineTimeoutError()), PIPELINE_BUDGET_MS)
  })
  try {
    await Promise.race([runPipelineInner(jobId, targetUrl), timeout])
  } catch (err: unknown) {
    if (err instanceof PipelineTimeoutError) {
      await updateJob(jobId, { status: "failed", error: "Exceeded time budget" })
    }
  } finally {
    // Clear the timer so it doesn't keep the Fluid Compute instance
    // alive past a quick completion.
    if (timeoutHandle) clearTimeout(timeoutHandle)
  }
}

async function runPipelineInner(jobId: string, targetUrl: string): Promise<void> {
  const spaBrowser = new SpaBrowser()

  try {
    await updateJob(jobId, { status: "crawling" })

    const baseUrl = normalizeUrl(targetUrl) || targetUrl

    // SSRF: block attempts to point the crawler at private/loopback/
    // metadata IPs before the first network call. Individual fetches
    // (fetchPage, sitemap, etc.) also pre-flight — this guards the
    // hot path and fails the job with a clear reason.
    try {
      await assertSafeUrl(baseUrl)
    } catch (err) {
      const reason = err instanceof UnsafeUrlError ? err.message : "unsafe URL"
      await updateJob(jobId, { status: "failed", error: reason })
      return
    }

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
    const isSpa = !!rawHomepageHtml && isSpaHtml(rawHomepageHtml, rawHomepageMeta?.bodyExcerpt || "")
    const needsBrowser = plainFetchFailed || isSpa
    if (needsBrowser) await spaBrowser.init()

    // Try the browser render as our homepage source when needed.
    let homepageHtml = rawHomepageHtml
    let homepageMeta = rawHomepageMeta
    if (needsBrowser) {
      const rendered = await spaBrowser.fetchPageWithLinks(baseUrl, baseUrl)
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
    const cappedUrls = capByPathPrefix(queue.map((q) => q.url), URLS_PER_PREFIX_CAP, PREFIX_SEGMENT_DEPTH)
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

    await updateJob(jobId, {
      progress: { discovered: discoveredUrls.size, crawled, failed },
    })

    // robots.txt Crawl-delay: gated through a shared `nextSlot`
    // across workers because per-worker sleeps don't space requests
    // when CONCURRENCY > 1. Capped at MAX_CRAWL_DELAY_MS so a hostile
    // `Crawl-delay: 99999` can't eat the pipeline budget. Without a
    // directive we fall back to per-worker politeness (HTTP only;
    // browser renders pace themselves).
    const crawlDelayMs = robots.crawlDelay != null
      ? Math.min(Math.max(0, Math.round(robots.crawlDelay * 1000)), MAX_CRAWL_DELAY_MS)
      : null
    let nextSlot = Date.now()
    const waitForRobotsSlot = async (): Promise<void> => {
      if (crawlDelayMs === null) return
      const now = Date.now()
      const start = Math.max(now, nextSlot)
      nextSlot = start + crawlDelayMs
      const wait = start - now
      if (wait > 0) await delay(wait)
    }

    // Worker pool: pull-based, no batch sync (JS sync code is atomic).
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
        if (crawlDelayMs !== null) {
          await waitForRobotsSlot()
        } else if (!needsBrowser) {
          await delay(POLITENESS_DELAY_MS + Math.random() * 100)
        }

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
          // No title needed: failed pages are filtered out before the
          // enrichment / scoring / output passes.
          failed++
          pages.push({ url, title: "", headings: [], fetchStatus: "error", descriptionProvenance: "none" })
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

    // Detect genre + site name. The deterministic extractor gives us
    // a cheap best-guess; the LLM then picks the actual brand out of
    // all the raw candidates (og:site_name, title, h1, JSON-LD) —
    // otherwise we end up storing things like
    // "Uber Eats | Food & Grocery Delivery | Order Groceries…" or a
    // cheerio-concatenated nav-icon mess as the dashboard label. If
    // the LLM is unavailable the deterministic guess is returned as-is.
    const hostname = new URL(baseUrl).hostname
    const genre = detectGenre(homepageHtml, [...discoveredUrls])
    const deterministicName = extractSiteName(homepageHtml, hostname)
    const nameCandidates = extractSiteNameCandidates(homepageHtml, hostname)
    const siteName = await llmSiteName(nameCandidates, hostname, deterministicName)

    // Strip pages whose description exactly matches the generic homepage tagline
    const homepageDesc = homepageMeta.description?.trim()
    const internalSuccessful = pages
      .filter((p) => p.fetchStatus === "ok")
      .map((p) => {
        if (homepageDesc && p.url !== baseUrl && p.description?.trim() === homepageDesc) {
          return { ...p, description: undefined, descriptionProvenance: "none" as const }
        }
        return p
      })

    // External references: homepage outbound anchors, LLM-ranked,
    // each fetched once for metadata only — never followed further.
    const externalRefs = await resolveExternalReferences(
      homepageHtml, baseUrl, siteName, homepageMeta.bodyExcerpt || "",
    )

    const successful = [...internalSuccessful, ...externalRefs]

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
    const withSections = assignSections(scored)
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

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/**
 * Gather external reference links from the homepage, let the LLM
 * pick the few worth keeping, and fetch each once for metadata.
 *
 * Fetches happen in parallel but are bounded by
 * `EXTERNAL_REFS_MAX_KEEP`. Any fetch that 4xx/5xx/timeouts falls
 * back to an anchor-text-only entry so we don't silently drop a
 * curated reference because one third-party server was flaky.
 */
async function resolveExternalReferences(
  homepageHtml: string,
  baseUrl: string,
  siteName: string,
  homepageExcerpt: string,
): Promise<ExtractedPage[]> {
  const candidates = extractExternalLinksFromHtml(homepageHtml, baseUrl)
  if (candidates.length === 0) return []

  const kept = await rankExternalReferences(
    candidates, siteName, homepageExcerpt, EXTERNAL_REFS_MAX_KEEP,
  )
  if (kept.length === 0) return []

  const fetched = await Promise.all(
    kept.map(async ({ url, anchor }): Promise<ExtractedPage | null> => {
      try {
        const res = await fetchPage(url)
        if (res.ok && res.html) {
          const meta = extractMetadata(url, res.html)
          return {
            ...meta,
            title: meta.title || anchor || hostnameFor(url),
            fetchStatus: "ok",
          }
        }
      } catch {
        // fall through to the anchor-text entry below
      }
      // The ref was curated by the LLM — keep it even if the fetch
      // failed. An entry with just an anchor-text title is more
      // useful than silently dropping a known-good reference.
      return {
        url,
        title: anchor || hostnameFor(url),
        headings: [],
        fetchStatus: "ok",
        descriptionProvenance: "none",
      }
    }),
  )
  return fetched.filter((p): p is ExtractedPage => p !== null)
}

function hostnameFor(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, "") } catch { return url }
}
