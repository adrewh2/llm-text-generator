// ─── Crawl tuning ────────────────────────────────────────────────────────────

/** Maximum number of pages to crawl per job. */
export const MAX_PAGES = 25

/** Maximum link-follow depth from the start URL. */
export const MAX_DEPTH = 2

/** Concurrent page fetches within the crawl. */
export const CONCURRENCY = 5

/** Milliseconds to wait between page fetches (politeness). */
export const POLITENESS_DELAY_MS = 300

/** Hours before a cached page is considered stale and re-crawled. */
export const PAGE_TTL_HOURS = 24

// ─── LLM section hints ───────────────────────────────────────────────────────

/**
 * Suggested section names for the LLM to consider when grouping pages.
 * These are hints, not constraints — the LLM may use them, adapt them,
 * or choose different names if they better fit the site's domain.
 */
export const SECTION_HINTS: string[] = [
  "Docs",
  "API",
  "Examples",
  "Optional",
]
