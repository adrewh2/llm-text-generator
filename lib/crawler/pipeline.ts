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
  // AbortController lets the inner pipeline self-terminate at stage
  // boundaries instead of running orphaned LLM + DB work after the
  // outer await has given up. On timeout the signal goes aborted;
  // the inner loop calls throwIfAborted at each stage to bail early.
  // Previously we used Promise.race which returned promptly but left
  // the inner pipeline running indefinitely in the background, still
  // consuming compute + Anthropic spend on work no one was waiting for.
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

    // Fetch homepage with plain HTTP first to detect SPA. If it fails
    // (bot-block, 4xx, timeout), fall through to the Puppeteer path
    // below — claude.ai and similar sites 403 against a plain fetch but
    // render fine in a real browser.
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

    // Surface the crawl mode to the progress UI. This is the first
    // point at which we know whether the rest of the crawl will go
    // through plain fetch (N workers in parallel) or Puppeteer
    // (single Chromium, serial). The ProgressPane's terminal line
    // reads this to explain why the browser path takes longer.
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

    // LLM ranking: intelligently select the most valuable URLs to crawl.
    // Preserve the LLM's output order — it has the full site context
    // (name, genre, homepage excerpt, complete URL set) and is better
    // placed to set priority than a path-based regex. The path regex
    // survives only as a tiebreaker below.
    const siteName0 = extractSiteName(homepageHtml, new URL(baseUrl).hostname)
    const homepageExcerpt = homepageMeta.bodyExcerpt || ""
    // Site's primary language comes from the homepage's <html lang>
    // attribute. Defaults to "en" when the site didn't bother setting
    // one — most such sites are English. Passed to scoring and LLM
    // prompts so prioritization reflects the site being generated
    // from, not a hardcoded assumption.
    const primaryLang = baseLangCode(homepageMeta.lang) ?? "en"

    // Hard filter: drop URLs whose path locale indicates a language
    // other than primary. apple.com's sitemap exposes /ae-ar/* and
    // /ja-jp/* alongside the English pages, and the score penalty
    // alone isn't enough to keep them out of the output because the
    // optional-section cap (10 slots) fills up with whatever's left
    // after primary. Removing them here means they never reach the
    // LLM ranker and never get crawled at all. URLs without a locale
    // prefix pass through — they're usually the primary-language
    // pages. Safety floor: if this would leave the queue empty (a
    // site that's ONLY locale-prefixed URLs), skip the filter so we
    // still produce some output.
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

    // Debounce progress writes. Previously we wrote after every page —
    // 25 crawled pages = 25 extra DB round-trips on the pipeline's hot
    // path. Now we batch on a min-interval AND a min-page count; the
    // polling UI refreshes every few seconds anyway, so sub-second
    // precision on `discovered` / `crawled` / `failed` doesn't buy
    // anything.
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

    // Site-name LLM call only needs the homepage's extracted
    // candidates — no dependency on crawled subpages — so kick it off
    // in parallel with the worker pool. Recovers ~5-10s on typical
    // sites where the LLM rate-limited or responded slowly.
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

    // External references: homepage outbound anchors, LLM-ranked,
    // each fetched once for metadata only — never followed further.
    // Budget stays within MAX_PAGES: whatever slots the internal
    // crawl didn't use, external refs can fill. At worst the cap is
    // hit by internals alone and no externals are fetched.
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

    // Derive blockquote summary from homepage description
    const summary =
      homepageMeta.description && homepageMeta.descriptionProvenance !== "none"
        ? homepageMeta.description
        : undefined

    const scored = scorePages(successful, genre, primaryLang, enrichment)
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

    // "partial" fires when a meaningful majority of fetch attempts
    // failed. Use total attempts (not just successes) as the denominator
    // so small crawls don't trip on a single failure. Require at least
    // 5 attempts before the rule kicks in — a 2-page site with 1
    // timeout shouldn't read as "partial".
    //
    // Also fail outright when we end up with zero useful pages in
    // the output (primary + optional both empty). This happens on
    // JS-only SPAs that our SPA detector missed *and* whose Puppeteer
    // render produced nothing meaningful either — without this the
    // assembler would emit a degenerate `# <siteName>` stub with no
    // sections. A clear failure is a better UX than a useless file.
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
