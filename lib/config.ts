// All tunable runtime constants live here, grouped by domain. The
// rule of thumb: if a number anywhere in the codebase would plausibly
// be changed for a business/UX reason, it belongs in this file.
// Everything here is safe to ship to the client bundle — no secrets.

// ─── Crawler tuning ──────────────────────────────────────────────────────────

export const crawler = {
  /** Maximum number of pages to crawl per job. */
  MAX_PAGES: 25,
  /** Maximum link-follow depth from the start URL. */
  MAX_DEPTH: 2,
  /** Concurrent page fetches within the crawl. */
  CONCURRENCY: 5,
  /** Politeness delay between fetches to the same target (ms). */
  POLITENESS_DELAY_MS: 300,
  /** Hours before a cached page is considered stale and re-crawled. */
  PAGE_TTL_HOURS: 24,
  /**
   * Max discovered URLs per path-prefix bucket before crawling. Belt-
   * and-suspenders alongside LLM ranking — keeps a single section of
   * a content-heavy site (e.g. 500 /watch URLs) from flooding the
   * queue the LLM ranks over. Long-term we could drop this cap
   * entirely and trust the LLM; for now it bounds the prompt size.
   */
  URLS_PER_PREFIX_CAP: 5,
  /** Path segments that form the prefix-bucket key. `/docs/api/x` + depth 2 → bucket `docs/api`. */
  PREFIX_SEGMENT_DEPTH: 2,
  /** Cap on sitemap parsing — stops a 1M-URL sitemap from OOMing us. */
  MAX_SITEMAP_URLS: 500,
  /** Sitemap fetch timeout. */
  SITEMAP_TIMEOUT_MS: 10_000,
  /** Homepage fetch timeout for the monitor's signature computation. */
  HOMEPAGE_FETCH_TIMEOUT_MS: 8_000,
  /** Max response body size accepted by fetchPage (bytes). */
  RESPONSE_MAX_BYTES: 5 * 1024 * 1024,
  /** Max redirect hops safeFetch will walk before giving up. */
  MAX_REDIRECTS: 5,
  /** UTF-8 byte cap on the excerpt we store per crawled page. */
  EXCERPT_MAX_BYTES: 4_096,
  /**
   * Hard ceiling on runCrawlPipeline total runtime. Stays under the
   * route's 300s maxDuration so we have room to write a clean "failed"
   * record instead of being terminated mid-flight.
   */
  PIPELINE_BUDGET_MS: 270_000,
  /**
   * Max external (cross-domain) reference links to include in the
   * output. Homepage anchors only — we extract every external link
   * from the homepage, the LLM ranks them, and the top N are fetched
   * once each for og:title / og:description. They flow through the
   * normal scoring + section-assignment pass alongside internal
   * pages, so a value that feels high is fine; the LLM ranker drops
   * social / tracking / footer noise.
   */
  EXTERNAL_REFS_MAX_KEEP: 8,
} as const

// ─── LLM enrichment ─────────────────────────────────────────────────────────

export const llm = {
  /** Single model pin — upgrade is a one-line swap. */
  MODEL: "claude-haiku-4-5-20251001" as const,
  /** Pages per request to enrichBatch. */
  ENRICH_BATCH_SIZE: 20,
  /** Max URLs rankCandidateUrls returns. */
  RANK_MAX_KEEP: 120,
  /** Candidate lists below this size skip LLM ranking entirely. */
  RANK_SKIP_BELOW: 10,
  /** Upper bound on the description the LLM can return (chars). */
  DESCRIPTION_MAX_CHARS: 240,
  /** Upper bound on the section name the LLM can return (chars). */
  SECTION_MAX_CHARS: 30,
}

/**
 * Suggested section names for the LLM to consider when grouping pages.
 * Hints, not constraints — the LLM may use them, adapt them, or
 * choose different names if they better fit the site's domain.
 */
export const SECTION_HINTS: readonly string[] = [
  "Docs",
  "API",
  "Examples",
  "Optional",
]

// ─── API surface ────────────────────────────────────────────────────────────

export const api = {
  /** Reject URLs beyond this length before any crawl work. */
  MAX_URL_LENGTH: 2048,
  /** Paginated dashboard list defaults. */
  PAGES_DEFAULT_LIMIT: 20,
  PAGES_MAX_LIMIT: 50,
  /** How many pages the user history zip endpoint loads at once. */
  DOWNLOAD_MAX_ENTRIES: 500,
}

// ─── Rate limiting ──────────────────────────────────────────────────────────

/**
 * Token-bucket configs for POST /api/p. Anon gets a small bucket so
 * a bot can't drain LLM budget; signed-in users can burst further
 * because we can revoke accounts individually.
 */
export const rateLimit = {
  ANON: { capacity: 3, refillPerSec: 3 / 3600 },
  AUTH: { capacity: 10, refillPerSec: 10 / 3600 },
}

// ─── Monitoring cron ────────────────────────────────────────────────────────

export const monitor = {
  /** Pages with no /api/p hit in this many days get unmonitored. */
  STALE_DAYS: 5,
  /** Rows pulled per cron invocation — oldest-checked first. */
  BATCH_SIZE: 200,
  /** Politeness delay between hits to the same host during a sweep. */
  SAME_HOST_DELAY_MS: 400,
}

// ─── Client UI timing ───────────────────────────────────────────────────────

export const ui = {
  /** /p/[id] polling cadence while a job is running. */
  POLL_INTERVAL_MS: 1_500,
  /** Consecutive poll failures before the client shows "lost connection". */
  MAX_POLL_FAILURES: 5,
  /** Minimum time each live-crawl step stays on screen. */
  LIVE_MIN_STEP_DWELL_MS: 1_200,
  /** Simulated-progress step durations for cached results (one per step). */
  SIM_STEP_DURATIONS_MS: [1800, 1600, 1400, 1200] as const,
  /** How often the "Refreshed X ago" label re-renders. */
  MONITOR_STATUS_TICK_MS: 10_000,
  /** LRU cap on the client-side per-tab job metadata cache. */
  JOB_CACHE_MAX: 30,
}
