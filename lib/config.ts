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
   * queue the LLM ranks over. Bounds the prompt size; the cap could
   * be dropped entirely if the LLM ranker proved sufficient on its
   * own. Within each bucket the shorter-path URL wins (the section
   * index over individual leaf pages — see capByPathPrefix).
   */
  URLS_PER_PREFIX_CAP: 5,
  /** Path segments that form the prefix-bucket key. `/docs/api/x` + depth 2 → bucket `docs/api`. */
  PREFIX_SEGMENT_DEPTH: 2,
  /** Cap on sitemap parsing — stops a 1M-URL sitemap from OOMing the function. */
  MAX_SITEMAP_URLS: 500,
  /**
   * Max response body accepted for a single sitemap fetch. The spec
   * allows up to 50 MB per file; this cap is lower because only the
   * first MAX_SITEMAP_URLS entries are extracted anyway, so anything
   * past this is guaranteed-unused payload.
   */
  SITEMAP_MAX_BYTES: 10 * 1024 * 1024,
  /** Sitemap fetch timeout. */
  SITEMAP_TIMEOUT_MS: 10_000,
  /** Homepage fetch timeout for the monitor's signature computation. */
  HOMEPAGE_FETCH_TIMEOUT_MS: 8_000,
  /** Max response body size accepted by fetchPage (bytes). */
  RESPONSE_MAX_BYTES: 5 * 1024 * 1024,
  /** Max redirect hops safeFetch will walk before giving up. */
  MAX_REDIRECTS: 5,
  /**
   * Upper bound on the `Crawl-delay` directive honored from a
   * target's robots.txt. The directive itself is authoritative, but
   * an adversarial site could set `Crawl-delay: 99999` and tie up the
   * whole pipeline budget on sleeps — cap it so any value beyond
   * saturates to this. 10 s × 25 pages = 250 s, just inside
   * PIPELINE_BUDGET_MS; a site asking for more produces a partial
   * crawl by design.
   */
  MAX_CRAWL_DELAY_MS: 10_000,
  /** UTF-8 byte cap on the excerpt stored per crawled page. */
  EXCERPT_MAX_BYTES: 4_096,
  /**
   * Hard ceiling on runCrawlPipeline total runtime. Stays under the
   * route's 300s maxDuration so the pipeline has room to write a
   * clean "failed" record instead of being terminated mid-flight.
   */
  PIPELINE_BUDGET_MS: 270_000,
  /**
   * Max external (cross-domain) reference links to include in the
   * output. Homepage anchors only — every external link on the
   * homepage is extracted, the LLM ranks them, and the top N are
   * fetched once each for og:title / og:description. They flow
   * through the normal scoring + section-assignment pass alongside
   * internal pages, so a value that feels high is fine; the LLM
   * ranker drops social / tracking / footer noise.
   */
  EXTERNAL_REFS_MAX_KEEP: 8,
  /**
   * Parametric fan-out drop threshold. When a single first-path-
   * segment hosts at least this many depth-2 URLs in the candidate
   * list (e.g. /city/{slug} × hundreds, /store/{id} × thousands,
   * /listing/{slug} × millions), treat the whole prefix as
   * templated fan-out and drop every URL under it. The parent index
   * page (the depth-1 URL like /location, /store, /listing) lives
   * in a different bucket and survives — that's what an LLM
   * actually needs from a directory-of-similar-items section. The
   * LLM ranker is too unreliable to enforce this on its own (it
   * scores each fan-out page individually, where each looks
   * legitimate), so the filter runs deterministically before
   * ranking. 20 is high enough that legitimate categorical sections
   * (a docs site with 10 top-level topics, an e-commerce site with
   * 5 product collections at depth 2) don't trip it, while
   * comfortably catching real fan-out.
   */
  FANOUT_DROP_THRESHOLD: 20,
} as const;

// ─── LLM enrichment ─────────────────────────────────────────────────────────

export const llm = {
  /** Single model pin — upgrade is a one-line swap. */
  MODEL: "claude-haiku-4-5-20251001" as const,
  /**
   * Retries per LLM call, passed through to the Anthropic SDK. The
   * SDK retries 408 / 429 / 5xx with exponential backoff + honours
   * `retry-after` / `x-should-retry` headers — exactly what Claude's
   * rate-limit behaviour requires. SDK default is 2; 5 gives ~30 s
   * of total backoff across a bursty minute, still well within the
   * pipeline budget.
   */
  MAX_RETRIES: 5,
  /**
   * Hard per-call timeout. A hung LLM request can otherwise eat the
   * whole 270 s pipeline budget; 60 s plus retries still leaves ~4
   * minutes for the rest of the crawl.
   */
  CALL_TIMEOUT_MS: 60_000,
  /** Pages per request to enrichBatch. Sized to match MAX_PAGES so a
   *  full-budget crawl ships in exactly one LLM round trip — internal
   *  crawl + external refs are bounded together at MAX_PAGES, so the
   *  combined `successful.length` never exceeds this. */
  ENRICH_BATCH_SIZE: 25,
  /** Max internal URLs rankSiteUrls keeps from the discovery candidate set. */
  RANK_MAX_KEEP: 120,
  /** Candidate lists below this size skip LLM ranking entirely. */
  RANK_SKIP_BELOW: 10,
  /** Upper bound on the description the LLM can return (chars). */
  DESCRIPTION_MAX_CHARS: 240,
  /** Upper bound on the section name the LLM can return (chars). */
  SECTION_MAX_CHARS: 30,
};

/**
 * Suggested section names for the LLM to consider when grouping pages.
 * Hints, not constraints — the LLM may use them, adapt them, or
 * choose different names if they better fit the site's domain. The
 * list intentionally covers both technical/docs sites (Docs, API,
 * Guides) and consumer / corporate / commerce sites (Products,
 * Services, Support) so the LLM has a ready label instead of
 * inventing a unique per-page name that later gets dissolved into
 * Optional by the single-page-section collapse.
 */
export const SECTION_HINTS: readonly string[] = [
  "Docs",
  "API",
  "Guides",
  "Examples",
  "Reference",
  "Tutorials",
  "Products",
  "Services",
  "Support",
  "Business",
  "Pricing",
  "About",
  "Blog",
  "Resources",
  "Optional",
];

// ─── API surface ────────────────────────────────────────────────────────────

export const api = {
  /** Reject URLs beyond this length before any crawl work. */
  MAX_URL_LENGTH: 2048,
  /** Paginated dashboard list defaults. */
  PAGES_DEFAULT_LIMIT: 20,
  PAGES_MAX_LIMIT: 50,
  /** How many pages the user history zip endpoint loads at once. */
  DOWNLOAD_MAX_ENTRIES: 500,
};

// ─── Rate limiting ──────────────────────────────────────────────────────────

/**
 * Token-bucket configs for POST /api/p. Two buckets per user class —
 * a loose submit floor that protects the cheap validation + HEAD
 * probe + DB-lookup path from abuse, and a tight new-crawl quota
 * that protects LLM / Puppeteer budget. Every submission deducts
 * from SUBMIT; only cache-miss submissions that actually dispatch a
 * fresh crawl also deduct from NEW_CRAWL. Anon buckets are smaller
 * than auth because abusive IPs can't be revoked individually.
 */
export const rateLimit = {
  ANON_SUBMIT: { capacity: 60, refillPerSec: 60 / 3600 },
  AUTH_SUBMIT: { capacity: 300, refillPerSec: 300 / 3600 },
  ANON_NEW_CRAWL: { capacity: 3, refillPerSec: 3 / 3600 },
  AUTH_NEW_CRAWL: { capacity: 50, refillPerSec: 50 / 3600 },
  /**
   * Cap on /api/monitor invocations, keyed globally (one bucket for
   * the whole cron). Legit load is 1 call/day from Vercel Cron; this
   * sits well above manual-testing needs but well below what a
   * leaked-CRON_SECRET attacker could use to amplify into Anthropic /
   * QStash spend (~800 LLM calls per invocation).
   */
  CRON_MONITOR: { capacity: 12, refillPerSec: 12 / 3600 },
  /**
   * /api/pages/download per-user cap. Zipping + delivering up to
   * DOWNLOAD_MAX_ENTRIES (500) page results is the most expensive
   * authenticated read on the surface — in-memory JSZip build + a
   * large response body. One token / 24 h is plenty for real use
   * (the zip is local once downloaded) and blocks a signed-in
   * attacker from looping the endpoint for amplification.
   */
  AUTH_ZIP_DOWNLOAD: { capacity: 1, refillPerSec: 1 / 86400 },
};

// ─── Monitoring cron ────────────────────────────────────────────────────────

export const monitor = {
  /** Pages with no /api/p hit in this many days get unmonitored. */
  STALE_DAYS: 5,
  /** Rows pulled per cron invocation — oldest-checked first. */
  BATCH_SIZE: 200,
  /** Politeness delay between hits to the same host during a sweep. */
  SAME_HOST_DELAY_MS: 400,
  /**
   * Jobs sitting in a non-terminal status with no `updated_at` write
   * for this long are force-failed by the sweeper. Sized well beyond
   * PIPELINE_BUDGET_MS (270s) + QStash retry overhead (3 tries) so
   * healthy retries never trip it. 15 minutes is comfortable headroom.
   */
  STUCK_JOB_AFTER_MS: 15 * 60 * 1000,
  /**
   * Per-recrawl QStash delivery delay used by the monitor cron to
   * spread enqueues over time instead of a single-minute burst.
   * Without this, N drifted URLs all enqueue back-to-back, all
   * workers fire 4 LLM calls each within seconds → instant Anthropic
   * RPM blow-out on cron storms. The cron passes
   * `delaySeconds = min(index * RECRAWL_STAGGER_SEC, RECRAWL_STAGGER_MAX_SEC)`
   * to enqueueCrawl. 5s/recrawl × 4 calls/crawl ≈ 48 LLM req/min start
   * rate, designed to sit just under the Tier 1 50 RPM ceiling. Bump
   * down once on a higher tier (Tier 2+ doesn't need staggering at
   * realistic batch sizes).
   */
  RECRAWL_STAGGER_SEC: 5,
  /**
   * Hard ceiling on the per-recrawl delay so a huge cron tick doesn't
   * schedule deliveries hours into the future. Beyond this cap, jobs
   * pile up at the same delay rather than continuing to spread.
   * 300s = 5 min covers a 60-recrawl tick at the default stride; for
   * bigger ticks the residual still fires within 5 min of cron start.
   */
  RECRAWL_STAGGER_MAX_SEC: 300,
};

// ─── Client UI timing ───────────────────────────────────────────────────────

export const ui = {
  /** /jobs/[id] polling cadence while a job is running. Progress
   *  counts only tick every few seconds during an active crawl, so a
   *  5 s cadence still feels live while keeping in-flight DB read
   *  pressure low. */
  POLL_INTERVAL_MS: 5_000,
  /** Consecutive poll failures before the client shows "lost connection". */
  MAX_POLL_FAILURES: 5,
  /** Minimum time each live-crawl step stays on screen. The fast-tail
   *  stages (scoring, assembling) often complete in under a second on
   *  the worker — without this floor they'd flash by before the user
   *  could read the label. JobView also defers its terminal-redirect
   *  to /p/{pageId} until the paced visible status catches up, so a
   *  real crawl that finishes mid-flight still shows every step
   *  reaching its green checkmark before the route transition. */
  LIVE_MIN_STEP_DWELL_MS: 1_200,
  /** How often the "Refreshed X ago" label re-renders. */
  MONITOR_STATUS_TICK_MS: 10_000,
};
