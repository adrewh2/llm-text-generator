# llms.txt Generator — System Design

## 1. Overview

A web app that generates a spec-compliant [`llms.txt`](https://llmstxt.org/) file for any public website. A user pastes a URL; the backend crawls the site, classifies and scores the discovered pages with a deterministic pipeline plus a small amount of LLM refinement, and assembles the output. Signed-in users get a dashboard of everything they've ever requested and can export it all as a zip.

The design is tight on purpose. Every URL produces one shared, globally-visible result, which is cheap to serve and trivial to share by link. A daily cron re-crawls pages that users have touched recently, so the canonical result doesn't drift.

### Design principles

1. **LLM does the judgment calls; deterministic code does the plumbing.** Every decision that requires taste is the LLM's: which of the discovered URLs are worth spending the 25-page budget on (`rankCandidateUrls`), how important each crawled page is on a 1–10 scale (`enrichBatch`), what section to put it in, what its description should say if the page didn't provide one, the site's brand name (`llmSiteName`), and the site's intro paragraph (`generateSitePreamble`). The deterministic layer handles the mechanics around those calls: robots/sitemap discovery, per-URL fetch + metadata extraction, SSRF validation, a base numeric score from structural signals (description present, `.md` sibling, JSON-LD, body length, URL-shape penalties), deduplication, and final markdown assembly.

   Where the two layers meet — selection and section assignment — the LLM's output is the dominant input. The importance rating folds into the score as `(importance − 5.5) × 5`, contributing roughly ±23 on top of base signals that cap around +75; that's large enough to flip pages across the primary (≥ 50) and optional (15–49) thresholds. Section names come from the LLM's suggestion first, with path-regex inference only as a fallback when the LLM didn't supply one. So calling inclusion or grouping "deterministic" would be wrong — the thresholds and grouping rules are deterministic, but the numbers and hints they operate on are not.
2. **Globally-shared result per URL.** One `llms.txt` per site, reused across all users. No per-user copies; no per-user mutations. Users get their own *history* (what they've asked for), but the *result* is shared.
3. **Crawl one URL once, keep it fresh passively.** A cached result under 24 hours old is returned immediately. A daily cron checks for upstream change on URLs that users are still actively using.
4. **Security is a pipeline concern, not a wrapper.** SSRF validation runs at every fetch hop; rate limiting runs on every `POST /api/p`; prompt injection defenses run on every LLM call.
5. **Everything lives on Vercel + Supabase.** Next.js on Fluid Compute, Postgres for durable state, Upstash Redis for rate-limiter state, Upstash QStash for the crawl-job queue. All provisioned via the Vercel Marketplace so env vars are wired into Production + Preview automatically. No self-hosted services, no edge runtime, no region sprawl.

### Scope

**In:** public HTTP(S) sites, a spec-compliant `llms.txt` output, sign-in for history + zip export, passive re-crawl on change.

**Out (and intentionally so):** authenticated crawling, user-editable overrides, webhook delivery of updates, hosted-file serving at the user's own `/llms.txt`, multi-tenant workspaces, GitHub PR write-back.

---

## 2. Tech Stack

| Layer | Choice |
|---|---|
| Framework | Next.js 15 (App Router), React 19 |
| Language | TypeScript 5, strict mode |
| Hosting | Vercel (Fluid Compute, Node 20+) |
| Auth + DB | Supabase (Postgres + Auth, SSR cookie handling) |
| HTML parse | `cheerio` |
| SPA fallback | `puppeteer-core` + `@sparticuz/chromium` |
| LLM | Anthropic Claude, pinned to `claude-haiku-4-5-20251001` |
| Archive export | `jszip` |
| Styling | Tailwind CSS 3, `lucide-react` icons |
| Cron | Vercel Cron (`vercel.json`) |

Two long-running routes (`app/api/p/route.ts`, `app/api/monitor/route.ts`) are given `maxDuration: 300s` in `vercel.json`; everything else uses the default. Crawl work itself is capped to `270s` (`crawler.PIPELINE_BUDGET_MS`) so there is time to write a clean `failed` state if the budget is exhausted.

---

## 3. Data Model

Three tables, all in `supabase/migration.sql`. RLS is enabled on all of them; the server uses the service-role key and bypasses RLS for writes, but the policies are the last line of defense if the anon key is ever misused.

### `pages` — canonical per-URL cache

```sql
url                TEXT PRIMARY KEY
result             TEXT                        -- final llms.txt, nullable until complete
site_name          TEXT
genre              TEXT
crawled_pages      JSONB                       -- ScoredPage[] used by the page explorer UI
monitored          BOOLEAN NOT NULL DEFAULT true
last_checked_at    TIMESTAMPTZ
last_requested_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
content_signature  TEXT                        -- sha256 of sitemap + homepage, used by cron
created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
```

Every page is **monitored by default**. The monitor cron unsets that flag on pages nobody has touched in the last 5 days, to keep the daily sweep bounded.

Policy: `pages_public_read` — `SELECT USING (true)`. Any client can read any completed `llms.txt`; this is intentional (share-by-link).

### `jobs` — one row per crawl execution

```sql
id          UUID PRIMARY KEY
page_url    TEXT NOT NULL REFERENCES pages(url) ON DELETE CASCADE
status      TEXT NOT NULL DEFAULT 'pending'    -- CHECK constraint enforces enum
progress    JSONB NOT NULL                     -- {discovered, crawled, failed}
site_name   TEXT
genre       TEXT
error       TEXT
created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
```

Status transitions: `pending → crawling → enriching → scoring → assembling → {complete | partial | failed}`. The enum is enforced by a `CHECK` constraint so a typo in client code can't corrupt the state machine.

`jobs` is a history, not a cache. Every crawl — first request, user-triggered re-crawl, monitor-triggered re-crawl — creates a new row. The *result* lives on the matching `pages` row.

Policy: `jobs_public_read` — `SELECT USING (true)`. A bare job id is a bearer token (UUID v4, not enumerable).

Index `idx_jobs_page_status_created(page_url, status, created_at DESC)` backs the dashboard's "latest terminal job per page" lookup.

### `user_requests` — per-user history

```sql
id          UUID PRIMARY KEY DEFAULT gen_random_uuid()
user_id     UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE
page_url    TEXT NOT NULL REFERENCES pages(url) ON DELETE CASCADE
created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
UNIQUE(user_id, page_url)
```

This is the *only* user-scoped data in the system. One row per (user, URL) pair records that a signed-in user asked for that URL. It's what the dashboard lists and what feeds the zip download.

Policy: `user_requests_own` — `auth.uid() = user_id` for both USING and WITH CHECK. This is the critical policy — it's what stops one user from reading another user's history.

Index `idx_user_requests_user_created(user_id, created_at DESC)` backs the paginated dashboard query.

### Why this shape

- No per-user result copies means a popular URL produces a single `pages` row and a single crawl, regardless of how many users have asked for it.
- `user_requests` carries no data beyond the join; overrides, notes, tags — nothing. Deleting a request removes it from your dashboard without affecting anyone else.
- The `ON DELETE CASCADE` from `pages(url)` is wired through both `jobs` and `user_requests` so a future cleanup job could drop a page cleanly.

---

## 4. Auth & User Model

Supabase Auth handles everything: GitHub and Google OAuth providers, SSR session cookies, server-side user lookup from the cookie.

- `/lib/supabase/server.ts` — server-side client; used by API routes and server components.
- `/lib/supabase/client.ts` — browser-side client; used for OAuth redirects and for `onAuthStateChange` wiring in the header nav.
- `/middleware.ts` — refreshes the session cookie on every request and redirects `/dashboard` to `/login` if there is no session. Only `/dashboard` is gated.

The app is **optionally-authenticated** on the main flow. Anyone can generate an `llms.txt` without signing in. Sign-in unlocks:

- `/dashboard` (history list)
- Higher rate limits (300/hr submit + 10/hr new crawls vs 60/hr + 3/hr anon — see §Rate limiting)
- `GET /api/pages` + `GET /api/pages/download` (history API + zip export)
- Remembering what you've asked for across devices

There is no preview/full mode distinction. Every crawl uses the same budget: 25 pages, depth 2. The only difference an account makes is how many crawls you can request per hour and whether the result shows up in your history.

---

## 5. API Surface

All routes live under `/app/api`.

| Method & path | Auth | Purpose |
|---|---|---|
| `POST /api/p` | Optional | Kick off a crawl, or return an existing job id if one is already running / cached. |
| `GET /api/p/[id]` | Public | Poll a job's status and fetch its result. |
| `DELETE /api/p/request?pageUrl=…` | Required | Remove a page from the signed-in user's history. |
| `GET /api/pages?offset&limit` | Required | Paginated dashboard list. |
| `GET /api/pages/download` | Required | Zip of every completed page in the user's history. |
| `GET /api/monitor` | Bearer `CRON_SECRET` | Vercel Cron target; runs the daily monitor sweep. |
| `GET /auth/callback` | — | OAuth return path, exchanges code for session. |

### `POST /api/p` — the hot path

Every new-crawl request lands here. The route:

1. Parses and validates the URL (`≤ 2048` chars, http(s), canonicalized via a HEAD probe that is itself SSRF-validated).
2. Looks up the principal: `user.id` if signed in, else the client IP. Consumes the **SUBMIT** token bucket — `AUTH_SUBMIT` (300/hr) or `ANON_SUBMIT` (60/hr) — a loose abuse floor charged on every POST. On miss, returns `429` with `reason: "submit_flood"`, `retryAfterSec`, and (for anon users) `signInPrompt: true`. Later, if the request branches into the new-crawl path, the tight **NEW_CRAWL** bucket — `AUTH_NEW_CRAWL` (10/hr) or `ANON_NEW_CRAWL` (3/hr) — is charged too; a denial at that point returns `429` with `reason: "new_crawl_quota"`. Cache-hit and in-flight-attach submissions *never* touch the new-crawl bucket, so a user whose new-crawl quota is exhausted can still reach already-cached URLs.
3. Checks for an existing `pages.result` under 24 hours old (`crawler.PAGE_TTL_HOURS`). If fresh, returns the most recent terminal job id with `cached: true` — no new crawl.
4. Checks for an in-flight job on the same URL. If one exists, returns its id with `cached: false`. This is what makes two users hitting the same URL simultaneously share one crawl.
5. Otherwise, creates a new `jobs` row and calls `enqueueCrawl(jobId, url)` (`lib/jobQueue.ts`), which publishes to QStash if `QSTASH_TOKEN` is set and falls back to `waitUntil(runCrawlPipeline(...))` for local dev. Either way the HTTP response returns immediately; the actual crawl runs later in the worker (`app/api/worker/crawl/route.ts` for the QStash path, the caller's own Fluid Compute instance for the fallback).
6. On all three branches (cache-hit, in-flight attach, new crawl), if the user is signed in, `upsertUserRequest` adds the URL to their dashboard history. The row is an upsert against `UNIQUE(user_id, page_url)` so re-submissions don't duplicate.

### `GET /api/p/[id]` — the poll target

Client polls every `ui.POLL_INTERVAL_MS` (1.5s) until the job is terminal. The route:

- Fetches the `jobs` row and, for terminal statuses, joins on `pages` for `result` and `crawled_pages`.
- Calls `bumpPageRequest(pageUrl)` on every non-failed status so `pages.last_requested_at` advances even while a user is watching a mid-flight job. This is how active pages stay monitored. Terminal responses are CDN-cached (below), so the bump fires once per `s-maxage` window rather than on every poll — still well under the 5-day sweeper threshold.
- Scrubs the `error` field (removes resolved IPs and SSRF-specific detail from user-facing text).
- Sets `Cache-Control: public, s-maxage=3600, stale-while-revalidate=86400` on terminal responses so Vercel's edge CDN serves repeat polls without touching Supabase. In-flight responses return `no-store` to keep progress live. Invalidation happens from the write side: when `updateJob` writes a new terminal result, it calls `revalidatePath('/api/p/:id')` for every job id that maps to that URL — required because `getJob` resolves `job.result` through `pages.result` by `page_url`, so a monitor re-crawl changes the JSON for every historical job id sharing the URL.

### `GET /api/monitor` — daily sweep

See §8.

---

## 6. Crawl Pipeline

All of this lives in `/lib/crawler/`. The entry point is `runCrawlPipeline(jobId, targetUrl)` in `pipeline.ts`.

```
normalize + SSRF-check
  ↓
robots.txt (disallows + sitemap references)
  ↓
sitemap(s) — up to 3 sources, capped at 500 URLs total
  ↓
homepage fetch (plain HTTP first, Puppeteer fallback if SPA / blocked)
  ↓
if sitemap was sparse: extract nav links from homepage
  ↓
capByPathPrefix: max 5 URLs per 2-segment path prefix
  ↓
LLM rank: Claude reorders candidate URLs by likely value
  ↓
Worker pool (5 non-SPA, 1 SPA): fetch + extract metadata for each URL
   - per-page: streaming HTML fetch (capped at RESPONSE_MAX_BYTES = 5 MB) + cheerio parse → ExtractedPage
   - probe for a .md sibling (HEAD, then lightweight GET)
   - discover more links if depth < MAX_DEPTH (2)
   - politeness: robots.txt Crawl-delay enforced as a shared clock across
     workers (capped at MAX_CRAWL_DELAY_MS = 10 s); when no directive is
     set, a per-worker POLITENESS_DELAY_MS = 300 ms baseline applies
   - hard caps: crawler.MAX_PAGES = 25, crawler.PIPELINE_BUDGET_MS = 270s
  ↓
genre detection (developer_docs, ecommerce, personal_site, institutional,
                 blog_publication, generic) from homepage + URL patterns
  ↓
resolveExternalReferences: homepage-only outbound anchors → LLM ranks
  down to crawler.EXTERNAL_REFS_MAX_KEEP (8) → each fetched once for
  metadata (no link discovery, depth 1 only) → merged into the page set
  ↓
LLM enrich (enrichBatch, batches of 20): returns pageType, importance 1–10,
  section hint, and a description where missing
  ↓
scorePages: structural signal weights (description presence, .md availability,
  JSON-LD, body length, URL-shape penalties) plus (importance − 5.5) × 5 from the LLM
  (genre is passed in but not currently used inside scorePages)
  ↓
assignSections: score ≥ 50 → primary (LLM-hinted or path-inferred section)
                15–49   → Optional
                < 15    → excluded
  ↓
filterAndSelectPages: dedupe by hostname+path, homepage excluded,
  cap primary at 50 and optional at 10 (60 total, sorted by score desc)
  ↓
generateSitePreamble: Claude writes a 1–3 sentence intro given genre + selected pages
  ↓
assembleFile: H1 + blockquote summary + preamble + H2 sections + Optional
  ↓
terminal status:
   crawled = 0                 → failed
   attempted ≥ 5 & rate < 50%  → partial
   otherwise                   → complete
```

The pipeline runs under a 270-second timeout enforced via `Promise.race`. If the timeout wins, the job is flipped to `failed` with a clean error; otherwise the inner function has already written its own success/failure state.

### SPA handling

`isSpaHtml(html, bodyExcerpt)` in `spaCrawler.ts` flags a response as SPA if the HTML is large but visible text is tiny, or if framework markers (`data-reactroot`, `ng-app`, unexpanded `{{ … }}`) are present, or if the plain fetch was blocked entirely. When triggered, the pipeline launches headless Chromium (`@sparticuz/chromium` on Vercel, bundled `puppeteer` locally), navigates with resource-blocking on for images/fonts/media, and uses the rendered DOM for both extraction and link discovery. Puppeteer is single-threaded within a job, so `CONCURRENCY` is forced to 1 when the browser path is active.

### Per-page extraction

`extractMetadata(url, html)` in `extract.ts` derives, in priority order:

- **Title:** `og:title` → `<title>` → first `<h1>`.
- **Description:** JSON-LD → `og:description` → `<meta name=description>` → first sentence of cleaned body → heading fallback → `none`. The winning source is stored as `descriptionProvenance` and used by the scorer to prefer structured sources over derived ones.
- **Body excerpt:** up to `crawler.EXCERPT_MAX_BYTES` (4 KB UTF-8) of cleaned text from the main content area, with nav/footer/aside stripped.
- **Canonical URL + lang** from standard tags.
- **`.md` sibling:** `probeMarkdown(url)` tries `{url}.md` and, for trailing-slash URLs, `{path}index.html.md` per the spec; HEAD first, falling back to a 4 KB GET if HEAD is unreliable; validated by content-type plus lightweight markdown signals.

### External references

The same-domain filter in `extractLinksFromHtml` is correct for the crawl queue — without it, a single outbound anchor would give the crawler permission to roam the web — but leaves the output with no cross-origin entries, even when the site explicitly links to its own spec / upstream docs / closely related projects. `resolveExternalReferences` in `pipeline.ts` bridges that gap.

Steps:

1. **Extract homepage externals only.** `extractExternalLinksFromHtml(homepageHtml, baseUrl)` collects cross-origin anchors with their anchor text. Subpages are intentionally ignored — homepage externals are the curated set the site itself vouches for.
2. **LLM ranks them.** `rankExternalReferences` (see §7) picks up to `crawler.EXTERNAL_REFS_MAX_KEEP` (8), dropping social-media profiles, tracking pixels, hosting badges, and similar noise.
3. **Fetch each once, for metadata only.** `fetchPage(url)` + `extractMetadata(url, html)` runs on each kept URL in parallel. If a fetch fails, the curated reference is kept with an anchor-text-only title rather than silently dropped.
4. **Merge into `successful`.** External entries flow through `llmEnrichPages`, `scorePages`, and `assignSections` alongside internal pages, so the LLM can place them in whatever section it thinks fits (often `Resources`, `References`, or a topic-specific label).

Depth is strictly 1 for externals by construction: `resolveExternalReferences` never calls `extractLinksFromHtml` on external HTML, and the fetched URLs never enter the crawl queue. They also don't count against `MAX_PAGES`. SSRF is preserved because `fetchPage` still goes through `safeFetch`, which validates every redirect hop.

### Scoring

`scorePages` in `score.ts` produces a numeric score per page from:

- structural signals (description presence +25, `.md` sibling +20, JSON-LD +10, headings +10, body ≥ 200 chars +10);
- URL-shape penalties (pagination −15, print/export −20, tag/category/archive/author −25);
- the LLM's importance rating, folded in as `Math.round((importance − 5.5) × 5)` — so `importance=10` contributes +23, `importance=1` contributes −23.

Thresholds: primary ≥ 50, optional 15–49, excluded < 15. These are starting points and can be tuned without touching structure. Note: `scorePages` takes a `genre` argument but does not currently use it — the old design spec'd genre-specific weight modifiers; those were never implemented. Genre is still computed and used elsewhere (LLM prompts, preamble context).

---

## 7. LLM Usage

Five call sites, all pinned to `claude-haiku-4-5-20251001`:

1. **`rankCandidateUrls`** — given up to `llm.RANK_MAX_KEEP` (120) URLs plus the site name and homepage excerpt, return the list re-ordered by likely value. Skipped entirely for candidate lists below `llm.RANK_SKIP_BELOW` (10).
2. **`enrichBatch`** (called from `llmEnrichPages`) — batches of `llm.ENRICH_BATCH_SIZE` (20) pages, run in parallel. Per page, returns `pageType`, `importance` (1–10), a `section` label, and a `description` (the LLM rewrites even when the page had one — replacement is kept only if it differs; provenance is then flipped to `llm`). The `section` value is the *primary* signal for primary pages (score ≥ 50); the path-regex inference runs only when the LLM didn't return a usable section. Pages with score < 50 are always placed into `Optional` regardless of what the LLM suggested.
3. **`rankExternalReferences`** — given homepage outbound anchors (URL + anchor text) plus the site name and homepage excerpt, return up to `crawler.EXTERNAL_REFS_MAX_KEEP` (8) curated references. Prompt is tuned to keep spec / upstream / related-project links and drop social media, tracking, hosting badges, and peripheral mentions. Skipped when there's nothing to prune (candidates ≤ `maxKeep`).
4. **`llmSiteName`** — given deterministic candidates (`og:site_name`, `application-name`, JSON-LD `name`, `<title>`, first `<h1>`) plus the hostname, returns a clean 1–4-word brand name. Falls back to the deterministic result when the LLM is unavailable or returns something unusable (see `cleanSiteName` in `siteName.ts`).
5. **`generateSitePreamble`** — given site name, genre, and the selected pages, returns a 1–3 sentence intro paragraph for the assembled file. If this call fails, the file is assembled without a preamble rather than faking one.

### What the LLM does *not* decide

- **Page type enum.** The LLM returns one, but anything outside the allowed set (doc/api/example/blog/changelog/about/product/pricing/support/policy/program/news/project/other) falls back to the deterministic `classifyPage()` regex in `classify.ts`.
- **Final link ordering inside a section.** Deterministic sort by score descending.
- **File assembly.** `assembleFile()` is pure text construction given its inputs.
- **Whether a page ends up in Optional.** Pages with a final score < 50 are always Optional (or excluded if < 15), regardless of what section the LLM suggested.

Everything else — which URLs get crawled under the 25-page cap, how each page's importance shifts its score, the section name for primary pages, descriptions where the extractor found none, the site brand name, the site preamble — is LLM-driven. Two runs on the same site can produce different outputs.

### Prompt injection defenses

Every chunk of crawled content embedded in an LLM prompt is passed through `neuter()` before being inserted into the prompt. It strips tag-like constructs (`</?tag>`), strips `[[…]]` prompt-template guards, and collapses all newlines to single spaces (so an attacker can't break out of the `<untrusted_pages>` fence with line-start tricks). Prompts also wrap untrusted content in an explicit `<untrusted_pages>` block with a preamble telling the model to treat everything inside as data.

On the output side, returned JSON is parsed and each field is re-validated before use: `pageType` must be in the whitelist (else `other`), `section` must match `[\p{L}\p{N} \-&/]+` and fit within `llm.SECTION_MAX_CHARS` (30), `description` is `neuter()`'d again and truncated to `llm.DESCRIPTION_MAX_CHARS` (240). Anything that doesn't match the expected shape is silently dropped so the deterministic fallback kicks in.

---

## 8. Monitoring

`GET /api/monitor` runs daily (`"0 0 * * *"` in `vercel.json`, the Vercel Hobby-plan cron ceiling), authenticated by a timing-safe compare against `CRON_SECRET`. There is no monitor state machine — monitoring is just a cron job that compares signatures and triggers re-crawls.

On each invocation:

1. **Force-fail stuck jobs.** `sweepStuckJobs(monitor.STUCK_JOB_AFTER_MS)` flips any job wedged in a non-terminal status with an `updated_at` older than 15 minutes to `failed`. This runs first so phantom in-flight rows (worker crash past QStash's retry window) don't keep blocking future submissions for the same URL.
2. **Sweep stale.** `sweepStaleMonitoredPages(monitor.STALE_DAYS)` sets `monitored = false` on any page whose `last_requested_at` is older than 5 days. This keeps the working set bounded to URLs people are actually using.
3. **Fetch a batch.** `getMonitoredPages({ limit: monitor.BATCH_SIZE })` pulls up to 200 monitored pages, oldest-checked first. Pages are processed sequentially, with a `monitor.SAME_HOST_DELAY_MS` (400 ms) politeness delay when two in a row share the same host.
4. **Compute signature.** `computeSignature(pageUrl)` in `monitor.ts` fetches the sitemap (via `fetchSitemapUrls`, which honors `crawler.SITEMAP_TIMEOUT_MS` = 10 s and `MAX_SITEMAP_URLS` = 500) and the homepage (8 s via `crawler.HOMEPAGE_FETCH_TIMEOUT_MS`) in parallel. Both go through `readBoundedText` so a server omitting or lying about `Content-Length` can't OOM the batch. Each is hashed separately — `sha256(sortedSitemapUrls.join("\n"))` and `sha256(normalizedHtml)` — then combined as `sha256("${sitemapHash}|${homepageHash}")`. If both fetches fail, it returns `null` (caller treats that as "skip this cycle"). Homepage normalization strips `<script>`, `<style>`, and comments and collapses whitespace so per-request build ids don't trigger false positives.
5. **Compare.** `detectChange` treats the first-ever check (no stored signature) as `changed: false` — it just records the baseline. On every subsequent check, a mismatch triggers `dispatchRecrawl()`, which creates a new `jobs` row and hands it to `enqueueCrawl` (same queue path as user submissions). A match is a no-op beyond updating the timestamp.
6. **Record.** `recordMonitorCheck(pageUrl, signature)` always updates `last_checked_at`; it only overwrites `content_signature` if the sig was computed successfully, so a transient fetch failure doesn't wipe the baseline.

A successful crawl also sets `last_checked_at = now()` in `updateJob()` (see `lib/store.ts:104`). So the moment a page is generated for the first time, the dashboard shows "Refreshed just now" — it doesn't dangle on "Awaiting check" until the next cron tick.

### Why stateless

An earlier draft had `monitors` and `monitor_runs` tables and a proper state machine (daily/weekly/monthly frequency, notification email, webhook delivery with HMAC, delivery-attempt tracking). All of that was cut. The product is: the cached result should not drift. A single daily sweep with a content signature hits that goal for a fraction of the complexity, and an update-delivery story (webhooks, email, reverse proxy) only makes sense once users ask for it.

---

## 9. Frontend

All pages live under `/app`. Highlights:

- **`/` (`app/page.tsx`)** — Landing page. URL input (auto-focused on mount), example output, "how it works" cards, sign-in upsell. Submitting the form `POST`s to `/api/p` and navigates to `/p/[id]`.
- **`/dashboard` (`app/dashboard/page.tsx`)** — Signed-in only. Server-rendered initial page (20 items) with `force-dynamic` so the RSC cache doesn't serve stale history after navigating back from `/p/[id]`. `PageList` is a client component that does infinite-scroll via an IntersectionObserver sentinel, calling `GET /api/pages` for subsequent pages. Each row shows site name, genre, requested-at, monitor status ("Refreshed X ago"), and a delete button that calls `DELETE /api/p/request`.
- **`/p/[id]` (`app/p/[id]/page.tsx`)** — Result viewer. Polls `GET /api/p/[id]` every 1.5 s until the job is terminal. Two panes swap in based on job state: `ProgressPane` for live crawls (animated step list with counts), `ResultPane` for complete/partial (read-only markdown block + copy + download). On terminal results, the page calls `validateLlmsTxt(result)` and renders the outcome as a "Spec valid" / "N issues" badge in the header, with an inline error list for invalid output. Cached results trigger a short simulated-progress animation (`SIM_STEP_DURATIONS_MS`) before revealing the result so the UI doesn't snap. After `MAX_POLL_FAILURES` (5) consecutive poll errors, the page shows a "Lost connection" banner with a reload button and stops polling (circuit breaker).
- **`/login` (`app/login/page.tsx`)** — OAuth picker (GitHub, Google).
- **`NavAuth` (`app/NavAuth.tsx`)** — Header component, present on `/` and `/p/[id]`. Renders "Sign in" for anon users, or a Dashboard link plus an account menu (email + sign out) for signed-in users. Subscribes to `onAuthStateChange` so the UI updates without a page refresh.
- **`ConfirmDialog` (`app/components/ConfirmDialog.tsx`)** — Generic modal, portaled to `document.body` to escape containing-block traps (an earlier embed inside a `-translate-y-1/2` wrapper broke `position: fixed`).

### Client-side caching

The result page keeps a per-tab LRU (`JOB_CACHE_MAX = 30`) of recently-seen jobs so tabbing between dashboard and result doesn't re-fetch. The cache is cleared on `SIGNED_OUT` to avoid a stale-view flash after logout.

---

## 10. Security Model

Full discussion in [`SECURITY.md`](./SECURITY.md). Summary:

### SSRF

`lib/crawler/ssrf.ts` exports `assertSafeUrl(url)`, which:

1. Accepts only `http:` and `https:`.
2. Resolves DNS and validates *every* answer, not just the first.
3. Blocks IPv4 RFC1918, loopback, link-local (including AWS metadata 169.254.169.254), multicast, unspecified, and benchmark ranges.
4. Blocks IPv6 loopback, link-local, unique-local, multicast, unspecified, and validates the IPv4 tail of `::ffff:x.x.x.x`-mapped addresses.

`lib/crawler/safeFetch.ts` is a manual-redirect fetch wrapper that re-runs `assertSafeUrl` on every hop (max `crawler.MAX_REDIRECTS = 5`). This is important: a redirect from `https://example.com` to `http://127.0.0.1` would pass an initial check but not a per-hop check.

Both the crawl pipeline entry and the Puppeteer path call `assertSafeUrl` before any network I/O.

Known limitation: TOCTOU between `assertSafeUrl` and the actual fetch (DNS rebinding could, in principle, swap the answer between the two lookups). Accepted because closing the gap requires pinning the socket to a specific IP at connect time, which Node's `fetch` doesn't expose. The window is narrow and the blast radius is a single GET.

### Rate limiting

Two token buckets per principal (principal = `user.id` when signed in, else client IP). Both live in `lib/rateLimit.ts`; both are backed by **Upstash Redis** (`@upstash/ratelimit`) in production, with an in-memory fallback for local dev.

| Bucket | Anon | Auth | Consumed when | Denial `reason` |
|---|---|---|---|---|
| `SUBMIT` | 60/hr | 300/hr | Every `POST /api/p` (abuse floor) | `submit_flood` |
| `NEW_CRAWL` | 3/hr | 10/hr | Only when the request dispatches a fresh crawl (cache miss + no in-flight attach) | `new_crawl_quota` |

The split lets normal users re-visit cached URLs freely while still protecting Anthropic / Puppeteer budget from a bot looping on fresh domains. A user whose `NEW_CRAWL` bucket is empty can still load any URL that's already in the global `pages` cache (same product), and only sees the "you've hit your limit for generating new pages" message when they try a genuinely new URL.

Redis keys are prefixed per bucket (`submit:…`, `newcrawl:…`) so the two limiters never share state. Denials return `429` with `Retry-After` plus a JSON body `{ error, reason, retryAfterSec, signInPrompt }`; the landing client renders "Try again in N minutes" using `retryAfterSec` and surfaces a Sign-In CTA when `signInPrompt` is set.

Backend selection:

- **Upstash Redis** (`@upstash/ratelimit`) when both `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` are set. State is centralized so instance churn / region failover / autoscale can't reset a user's bucket, and the limits hold up against distributed IPs. On a transient Redis error the limiter fails open (logged) — a flaky Redis shouldn't take down all crawl submissions.
- **In-memory token bucket** otherwise. Keeps `npm run dev` working without a Redis dependency. Fine for a single Fluid Compute instance; not fit for production at scale since a cold-start or autoscale event gives the attacker a fresh bucket.

### Prompt injection

See §7. Neutering before injection + schema-validated output + hard length caps. A malicious page can make the LLM return garbage for its own description; it cannot escape the shape or poison a different page's output.

### RLS

Service-role key stays server-side (`lib/store.ts:17`). Client never sees it. RLS policies are the last line of defense: even if the anon key is exfiltrated, a direct Supabase query cannot read another user's `user_requests` rows. `pages` and `jobs` are deliberately world-readable — a job id is a non-enumerable UUID v4, and the point of the product is that the `llms.txt` output is shareable.

### Headers

`next.config.ts` sets on every response:

- **Content-Security-Policy** — `default-src 'self'`, `script-src 'self' 'unsafe-inline' 'unsafe-eval'` (required for Next.js's RSC bootstrap and HMR — documented trade-off in the file's comment), `style-src 'self' 'unsafe-inline'`, `img-src 'self' data: blob: https:`, `font-src 'self' data: https://fonts.gstatic.com`, `connect-src 'self' https://*.supabase.co wss://*.supabase.co`, `frame-ancestors 'self'`, `form-action 'self'`, `base-uri 'self'`, `object-src 'none'`.
- `X-Frame-Options: SAMEORIGIN`
- `X-Content-Type-Options: nosniff`
- `Referrer-Policy: strict-origin-when-cross-origin`
- `Permissions-Policy: camera=(), microphone=(), geolocation=(), interest-cohort=()`

### Cron authentication

`GET /api/monitor` checks the `Authorization: Bearer <token>` header against `CRON_SECRET` with a timing-safe compare. Vercel Cron sets this header automatically.

### Secret handling

No API key or token ever reaches the log stream. Error messages embedded in job rows are scrubbed before being returned to `/api/p/[id]` — resolved IPs and SSRF-specific detail are stripped so an attacker can't use our error text as a port scanner.

---

## 11. Config Surface

All tunable constants are in `/lib/config.ts`, grouped by domain. This is the single place to change anything that might plausibly be adjusted for business or UX reasons. Values below are current as of this document:

- **`crawler`** — `MAX_PAGES: 25`, `MAX_DEPTH: 2`, `CONCURRENCY: 5`, `POLITENESS_DELAY_MS: 300`, `PAGE_TTL_HOURS: 24`, `URLS_PER_PREFIX_CAP: 5`, `PREFIX_SEGMENT_DEPTH: 2`, `MAX_SITEMAP_URLS: 500`, `SITEMAP_MAX_BYTES: 10 MB`, `SITEMAP_TIMEOUT_MS: 10_000`, `HOMEPAGE_FETCH_TIMEOUT_MS: 8_000`, `RESPONSE_MAX_BYTES: 5 MB`, `MAX_REDIRECTS: 5`, `MAX_CRAWL_DELAY_MS: 10_000`, `EXCERPT_MAX_BYTES: 4 KB`, `PIPELINE_BUDGET_MS: 270_000`, `EXTERNAL_REFS_MAX_KEEP: 8`.
- **`llm`** — `MODEL: claude-haiku-4-5-20251001`, `ENRICH_BATCH_SIZE: 20`, `RANK_MAX_KEEP: 120`, `RANK_SKIP_BELOW: 10`, `DESCRIPTION_MAX_CHARS: 240`, `SECTION_MAX_CHARS: 30`.
- **`api`** — `MAX_URL_LENGTH: 2048`, `PAGES_DEFAULT_LIMIT: 20`, `PAGES_MAX_LIMIT: 50`, `DOWNLOAD_MAX_ENTRIES: 500`.
- **`rateLimit`** — `ANON_SUBMIT: { capacity: 60, refillPerSec: 60/3600 }`, `AUTH_SUBMIT: { capacity: 300, refillPerSec: 300/3600 }`, `ANON_NEW_CRAWL: { capacity: 3, refillPerSec: 3/3600 }`, `AUTH_NEW_CRAWL: { capacity: 10, refillPerSec: 10/3600 }`.
- **`monitor`** — `STALE_DAYS: 5`, `BATCH_SIZE: 200`, `SAME_HOST_DELAY_MS: 400`, `STUCK_JOB_AFTER_MS: 900_000`.
- **`ui`** — `POLL_INTERVAL_MS: 1_500`, `MAX_POLL_FAILURES: 5`, `LIVE_MIN_STEP_DWELL_MS: 1_200`, `SIM_STEP_DURATIONS_MS: [1800, 1600, 1400, 1200]`, `MONITOR_STATUS_TICK_MS: 10_000`, `JOB_CACHE_MAX: 30`.

Secrets come from environment variables: `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL`, and `SUPABASE_ANON_KEY` are loaded via `lib/env.ts`'s `requireEnv()` so a missing value fails fast; `ANTHROPIC_API_KEY` and `CRON_SECRET` are read directly with `process.env` because their call sites already handle absence (LLM features degrade to deterministic fallbacks, and the cron endpoint fails closed).

---

## 12. Key Design Decisions & Trade-offs

### Globally-shared `pages` row

*Trade-off:* No per-user customization, no user-scoped exclusions, no private results. *Why:* the product is "generate a valid `llms.txt` for a public website"; there's no meaningful notion of a user-private version. Sharing the row means the same URL crawls once no matter how many users ask for it, and the dashboard is effectively free to render.

### Stateless monitoring

*Trade-off:* No per-user frequency preferences, no webhook delivery, no per-run diff storage. *Why:* the product promise is "your cached result won't drift", not "you'll be notified of every change". A daily sweep with a signature compare is ~30 lines; a full monitor system is a separate product.

### Single pinned LLM model

*Trade-off:* No per-call model selection, no fallback tier. *Why:* Haiku is fast and cheap enough for description writing; a swap is one line in `lib/config.ts`. Anything fancier (Sonnet for the preamble, Haiku for pages) adds complexity without a proven quality delta on this task.

### Crawl execution backend

*Trade-off:* The same `enqueueCrawl(jobId, url)` helper in `lib/jobQueue.ts` has two backends chosen at call time. *Why:* production (Vercel + `QSTASH_TOKEN` set) publishes to QStash, which then POSTs the signed job to `/api/worker/crawl`; the worker runs the pipeline synchronously so QStash's retry-on-non-2xx semantics buy us real mid-pipeline durability. Local dev (no `QSTASH_TOKEN`) keeps the pre-queue behaviour — `waitUntil(runCrawlPipeline(...))` in the caller's own Fluid Compute instance — so `npm run dev` works without a publicly reachable callback URL. The caller-side code path is one line in both cases (`await enqueueCrawl(id, url)`).

### Rate limiter backend

*Trade-off:* The same module has an in-memory path (dev) and a Redis path (prod) selected by env. *Why:* local dev shouldn't require a network dependency, and the interface is identical in both paths so callers are unaffected. Upstash is the production target because Vercel KV is deprecated and Upstash Redis is the Marketplace-recommended replacement; the `@upstash/ratelimit` library wraps the right Lua-atomic token-bucket primitives.

### Public `jobs` reads

*Trade-off:* Anyone with a job id can see a job's status and, if terminal, its result. *Why:* a job id is a non-enumerable UUID, and shareable result URLs are a feature, not a leak. The *history* — which URLs a user has asked for — is still private via RLS on `user_requests`.

### LLM ranks + deterministic thresholds

*Trade-off:* Two systems to tune (LLM importance + hand-weighted signals). *Why:* the LLM has full site context and is much better at "is this the right page to show"; the deterministic signals are much better at "is this page actually parseable and link-worthy". Combining them is more robust than either alone.

### No Puppeteer for non-SPA sites

*Trade-off:* Can't run any JS. *Why:* Puppeteer is 5–20× slower and requires a heavier runtime bundle. The SPA detector (`isSpaHtml`) is conservative: fall through to Puppeteer only if the plain fetch is blocked, the HTML is an empty shell, or framework markers are present.

---

## 13. What's Intentionally Deferred

The following are out of scope for the current implementation. Each is plausible for a V2, but none are required for the MVP promise.

- **User-editable overrides.** No override versioning, no persistent per-user edits to the generated file, no merge policy on re-crawl. Users who want custom output copy the result and edit it locally.
- **Update delivery.** No webhook HMAC, no email notifications, no hosted-file endpoint at `/files/:id/llms.txt`. Users are expected to host their own `/llms.txt`.
- **Locale policy controls.** The crawler treats alternate-locale URLs like any other URL; the LLM tends to filter them naturally via the ranking step. Surface controls (prefer x-default, target one locale) would go in the `crawler` section of `lib/config.ts`.
- **Per-domain global throttle across jobs.** Within a single pipeline the crawler honors `robots.txt` `Crawl-delay` via a shared cross-worker clock (capped at `MAX_CRAWL_DELAY_MS` = 10 s). Between concurrent jobs against the same target, there is no cross-job coordination, so a popular URL burst could send workers from multiple pipelines at the same host. Mitigated in practice by the 24-hour cache hit on repeat requests.
- **Test suite.** No unit, integration, or snapshot tests are wired up. This is the first thing to add if the project moves beyond a take-home demo.

---

## 14. Repository Layout

```
/app
  page.tsx                           landing
  layout.tsx                         root RSC shell
  NavAuth.tsx                        header auth component
  /api
    /p/route.ts                      POST: kick off / return-cached
    /p/[id]/route.ts                 GET:  poll job
    /p/request/route.ts              DELETE: remove from history
    /pages/route.ts                  GET:  paginated history
    /pages/download/route.ts         GET:  zip export
    /monitor/route.ts                GET:  cron handler
    /worker/crawl/route.ts           POST: QStash-signed crawl worker
  /auth/callback/route.ts            OAuth return
  /login/page.tsx                    OAuth picker
  /dashboard
    page.tsx                         server-rendered initial list
    PageList.tsx                     infinite-scroll client
    JobActions.tsx                   delete + confirm
    MonitorStatus.tsx                "Refreshed X ago"
    SignOutButton.tsx
  /p/[id]
    page.tsx                         result viewer (polling)
    ProgressPane.tsx                 live crawl animation
    ResultPane.tsx                   markdown render + copy/download
    types.ts                         ApiJob
    useVisibleStatus.ts              status display state machine
  /components/ConfirmDialog.tsx

/lib
  config.ts                          all tunable constants
  env.ts                             requireEnv()
  log.ts                             debugLog()
  rateLimit.ts                       token bucket (Upstash Redis + in-memory fallback)
  jobQueue.ts                        enqueueCrawl (QStash + waitUntil fallback)
  store.ts                           Supabase queries (service-role)
  /supabase
    client.ts                        browser client (anon)
    server.ts                        server SSR client (anon + cookie handling)
  /crawler
    pipeline.ts                      orchestration
    types.ts                         ExtractedPage, ScoredPage, CrawlJob, JobStatus
    ssrf.ts                          assertSafeUrl + forbidden ranges
    safeFetch.ts                     per-hop redirect validation
    fetchPage.ts                     main page fetcher
    readBounded.ts                   streaming body read with hard byte cap
    robots.ts                        robots.txt parse
    sitemap.ts                       sitemap fetch + parse
    spaCrawler.ts                    Puppeteer + SPA detection
    discover.ts                      link extraction from HTML
    extract.ts                       per-page metadata extraction
    siteName.ts                      site-name cleaning + hostname fallback
    markdownProbe.ts                 .md variant probing
    url.ts                           normalize, capByPathPrefix, skip heuristics
    urlLabel.ts                      URL → human-ish filename for zip export
    classify.ts                      page-type classification
    genre.ts                         site genre detection
    score.ts                         scoring with LLM importance
    group.ts                         section assignment + selection
    llmEnrich.ts                     rankCandidateUrls + enrichBatch + preamble
    assemble.ts                      final markdown assembly
    validate.ts                      spec compliance check (run in /p/[id])
    monitor.ts                       computeSignature + detectChange

/supabase/migration.sql              full schema (pages, jobs, user_requests, RLS)

/middleware.ts                       Supabase SSR session + /dashboard gate
/next.config.ts                      CSP + security headers
/vercel.json                         function duration + cron schedule
/docs/SECURITY.md                    threat model + defenses
```

---

## 15. Callouts and Future Work

- **Concurrent cache-miss race.** `POST /api/p` checks `getActiveJobForUrl` (route.ts:88) and attaches to an in-progress job if one exists, which handles sequential duplicates. But there's no DB-level lock or unique constraint between that check and `createJob` on line 100 — two truly simultaneous requests for the same uncached URL can both pass the check and both fire `runCrawlPipeline`, duplicating LLM/crawl spend. The failure mode is benign (the second pipeline's `pages` upsert harmlessly overwrites the first; user sees one result) so it's deferred for the MVP. Fix: partial unique index on `(url)` for active jobs with `ON CONFLICT DO NOTHING`, or a `SELECT ... FOR UPDATE` around the check/insert.
