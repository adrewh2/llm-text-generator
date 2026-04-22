import { fetchRobots, isAllowed, hasFullDisallow } from "./discovery/robots"
import { fetchSitemapUrls } from "./discovery/sitemap"
import { fetchPage } from "./discovery/fetchPage"
import { extractMetadata, extractSiteName, extractSiteNameCandidates } from "./enrich/extract"
import { probeMarkdown } from "./discovery/markdownProbe"
import { extractLinksFromHtml, extractExternalLinksFromHtml } from "./discovery/discover"
import { isSpaHtml, SpaBrowser } from "./discovery/spaCrawler"
import { scorePages } from "./enrich/score"
import { llmEnrichPages, generateSitePreamble, rankCandidateUrls, rankExternalReferences, llmSiteName } from "./enrich/llmEnrich"
import { baseLangCode, urlLocaleCode } from "./net/language"
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
  // Budget timeout via AbortController so stages can bail at boundaries
  // instead of orphaning LLM + DB work in the background.
  const ac = new AbortController()
  const timeoutHandle = setTimeout(() => {
    ac.abort(new PipelineTimeoutError())
  }, PIPELINE_BUDGET_MS)

  try {
    await runPipelineInner(jobId, targetUrl, ac.signal)
  } catch (err: unknown) {
    if (err instanceof PipelineTimeoutError || ac.signal.aborted) {
      await updateJob(jobId, { status: "failed", error: "Exceeded time budget" })
    }
    // Non-timeout errors are already handled inside runPipelineInner's
    // own catch (writes a `failed` state with the actual error). If one
    // escapes, it reaches the worker route's 500 handler and QStash retries.
  } finally {
    clearTimeout(timeoutHandle)
  }
}

async function runPipelineInner(
  jobId: string,
  targetUrl: string,
  signal: AbortSignal,
): Promise<void> {
  const spaBrowser = new SpaBrowser()

  try {
    await updateJob(jobId, { status: "crawling" })

    const baseUrl = normalizeUrl(targetUrl) || targetUrl

    // SSRF: block private/loopback/metadata IPs up front. Individual
    // fetches also pre-flight; this fails the job with a clear reason.
    try {
      await assertSafeUrl(baseUrl)
    } catch (err) {
      const reason = err instanceof UnsafeUrlError ? err.message : "unsafe URL"
      await updateJob(jobId, { status: "failed", error: reason })
      return
    }

    // Fetch robots.txt
    signal.throwIfAborted()
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

    // Plain HTTP first; fall through to Puppeteer on failure or when
    // the response looks like a JS shell / bot challenge.
    signal.throwIfAborted()
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

    // Surface the crawl mode so ProgressPane can warn that browser
    // renders are slower (single Chromium, serial vs. N plain workers).
    await updateJob(jobId, {
      progress: {
        discovered: discoveredUrls.size,
        crawled: 0,
        failed: 0,
        mode: needsBrowser ? "browser" : "http",
      },
    })

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

    // LLM ranks the candidate URLs using full site context. Its order
    // wins; path-based regex is only a tiebreaker downstream.
    const siteName0 = extractSiteName(homepageHtml, new URL(baseUrl).hostname)
    const homepageExcerpt = homepageMeta.bodyExcerpt || ""
    // Primary language from <html lang> on the homepage; "en" default.
    const primaryLang = baseLangCode(homepageMeta.lang) ?? "en"

    // Hard-drop URLs whose path locale is not the primary language
    // (e.g. /ja-jp/* on an en-primary site). Score penalty alone is
    // insufficient — optional-section slots would fill with localised
    // dupes. Pass through URLs with no locale prefix. Safety floor:
    // skip the filter if it would empty the queue.
    const preFiltered = queue.filter((q) => {
      const locale = urlLocaleCode(q.url)
      return !locale || locale === primaryLang
    })
    if (preFiltered.length > 0 && preFiltered.length < queue.length) {
      queue.splice(0, queue.length, ...preFiltered)
    }

    signal.throwIfAborted()
    const rankedUrls = await rankCandidateUrls(
      queue.map((q) => q.url),
      siteName0,
      homepageExcerpt,
      primaryLang,
    )
    const urlToItem = new Map(queue.map((q) => [q.url, q]))
    const reordered = rankedUrls
      .map((u) => urlToItem.get(u))
      .filter((q): q is { url: string; depth: number } => !!q)
    queue.splice(0, queue.length, ...reordered)

    const mode: "http" | "browser" = needsBrowser ? "browser" : "http"
    await updateJob(jobId, {
      progress: { discovered: discoveredUrls.size, crawled, failed, mode },
    })

    // Shared `nextSlot` gates Crawl-delay across workers (per-worker
    // sleeps don't space requests when CONCURRENCY > 1). Capped to
    // MAX_CRAWL_DELAY_MS to bound hostile values.
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

    // Debounce progress writes — polling UI tick is seconds, so
    // sub-second precision isn't worth a DB round-trip per page.
    const PROGRESS_MIN_INTERVAL_MS = 500
    let lastProgressAt = 0
    const flushProgress = async (force = false): Promise<void> => {
      const now = Date.now()
      if (!force && now - lastProgressAt < PROGRESS_MIN_INTERVAL_MS) return
      lastProgressAt = now
      await updateJob(jobId, { progress: { discovered: discoveredUrls.size, crawled, failed, mode } })
    }

    // Worker pool: pull-based, no batch sync (JS sync code is atomic).
    let queueIdx = 0
    const worker = async (): Promise<void> => {
      while (crawled < MAX_PAGES) {
        if (signal.aborted) return
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

        await flushProgress()
      }
    }

    // Kick off the site-name LLM call in parallel with the worker
    // pool — it only needs the homepage, not the crawled subpages.
    const hostname = new URL(baseUrl).hostname
    const deterministicName = extractSiteName(homepageHtml, hostname)
    const nameCandidates = extractSiteNameCandidates(homepageHtml, hostname)
    const siteNamePromise = llmSiteName(nameCandidates, hostname, deterministicName)

    await Promise.all(Array.from({ length: needsBrowser ? 1 : CONCURRENCY }, () => worker()))
    // Final flush so the UI sees the last batch's counts even when
    // they arrived inside the min-interval window.
    await flushProgress(true)

    // Genre needs the crawled URL set, so it runs after the worker
    // pool. `llmSiteName` may still be in flight at this point —
    // awaiting it costs only whatever time it hasn't already spent.
    const genre = detectGenre(homepageHtml, [...discoveredUrls])
    const siteName = await siteNamePromise

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

    // External refs fill any unused MAX_PAGES budget. Each is fetched
    // once for metadata only — never followed further.
    const externalBudget = Math.max(0, MAX_PAGES - internalSuccessful.length)
    const externalRefs = externalBudget > 0
      ? await resolveExternalReferences(
          homepageHtml, baseUrl, siteName, homepageMeta.bodyExcerpt || "", externalBudget,
        )
      : []

    const successful = [...internalSuccessful, ...externalRefs]

    // LLM enrichment: classify pages and generate missing descriptions
    signal.throwIfAborted()
    await updateJob(jobId, { status: "enriching", genre, siteName })
    const enrichment = await llmEnrichPages(successful, siteName, genre, primaryLang)

    signal.throwIfAborted()
    await updateJob(jobId, { status: "scoring" })

    const scored = scorePages(successful, genre, primaryLang, enrichment)

    // Blockquote summary uses the post-enrichment homepage description,
    // gated on trusted provenance — body-excerpt / heading fallbacks
    // often surface nav goo that reads badly in a blockquote.
    const homepageScored = scored.find((p) => p.url === baseUrl)
    const summary =
      homepageScored?.description &&
      (homepageScored.descriptionProvenance === "json_ld" ||
        homepageScored.descriptionProvenance === "og" ||
        homepageScored.descriptionProvenance === "meta" ||
        homepageScored.descriptionProvenance === "llm")
        ? homepageScored.description
        : undefined

    const withSections = assignSections(scored)
    const { primary, optional } = filterAndSelectPages(withSections, baseUrl)

    // Deduplicate for display
    const seenUrls = new Set<string>()
    const dedupedSections = withSections.filter((p) => {
      if (seenUrls.has(p.url)) return false
      seenUrls.add(p.url)
      return true
    })

    signal.throwIfAborted()
    await updateJob(jobId, { status: "assembling" })

    const preamble = await generateSitePreamble(siteName, genre, primary, optional, primaryLang)
    const robotsNotice = robotsFullBlock
      ? "Note: This site's robots.txt disallows all crawling (Disallow: /). Only the homepage could be indexed; the full site structure may not be represented here."
      : undefined
    const result = assembleFile(siteName, primary, optional, summary, preamble, robotsNotice)

    // "partial" when >50% of attempts failed (min 5 attempts so a
    // 2-page site with 1 timeout doesn't trip it). Fail outright when
    // the output would have no sections — better than shipping a
    // degenerate `# <siteName>` stub.
    const attempted = crawled + failed
    const successRate = attempted > 0 ? crawled / attempted : 0
    const status =
      crawled === 0                                 ? "failed"
      : primary.length === 0 && optional.length === 0 ? "failed"
      : attempted >= 5 && successRate < 0.5         ? "partial"
      : "complete"

    const error =
      status === "failed" && primary.length === 0 && optional.length === 0
        ? "browser render failed"  // scrubError maps this to "We couldn't render this site."
        : undefined

    await updateJob(jobId, {
      status,
      result,
      pages: dedupedSections,
      genre,
      siteName,
      ...(error ? { error } : {}),
    })
  } catch (err: unknown) {
    // Timeout is handled by runCrawlPipeline's outer catch (single
    // source of truth for the "Exceeded time budget" message). Re-throw
    // so the outer handler writes the failed state.
    if (err instanceof PipelineTimeoutError || signal.aborted) throw err
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
  budget: number = EXTERNAL_REFS_MAX_KEEP,
): Promise<ExtractedPage[]> {
  if (budget <= 0) return []
  const candidates = extractExternalLinksFromHtml(homepageHtml, baseUrl)
  if (candidates.length === 0) return []

  const maxKeep = Math.min(budget, EXTERNAL_REFS_MAX_KEEP)
  const kept = await rankExternalReferences(
    candidates, siteName, homepageExcerpt, maxKeep,
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
