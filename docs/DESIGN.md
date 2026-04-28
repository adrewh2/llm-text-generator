# llms.txt Generator — Design

This doc is the narrative: data model, API surface, pipeline decisions,
trade-offs, config surface, and repo layout. For the visual-first
shape (component + sequence diagrams, stage-by-stage UI narrative) see
[`SYSTEM-DESIGN.md`](./SYSTEM-DESIGN.md). For threat model, rate
limits, and RLS policies see [`SECURITY.md`](./SECURITY.md).

---

## 1. Overview

A web app that generates a spec-compliant [`llms.txt`](https://llmstxt.org/) file for any public website. A user pastes a URL; the backend crawls the site, classifies and scores the discovered pages with a deterministic pipeline plus a small amount of LLM refinement, and assembles the output. Signed-in users get a dashboard of everything they've ever requested and can export it all as a zip.

The design is tight on purpose. Every URL produces one shared, globally-visible result, which is cheap to serve and trivial to share by link. A daily cron re-crawls pages that users have touched recently, so the canonical result doesn't drift.

### Design principles

1. **LLM does the judgment calls; deterministic code does the plumbing.** Every decision that requires taste is the LLM's: which discovered URLs are worth spending the 25-page budget on AND which homepage outbound links are worth referencing (one merged `rankSiteUrls` call), how important each crawled page is on a 1–10 scale and what section / description to give it (`enrichBatch`), the site's brand name AND its intro paragraph (one merged `analyzeSiteHomepage` call), and a final whole-file review of the assembled draft to drop residual noise, reassign or consolidate entries between sections, and reorder sections (`llmFinalReview`). The deterministic layer handles the mechanics around those calls: robots/sitemap discovery, per-URL fetch + metadata extraction, SSRF validation, parametric-fan-out URL filtering, a base numeric score from structural signals (description present, `.md` sibling, JSON-LD, body length, URL-shape penalties), deduplication, and final markdown assembly.

   Where the two layers meet — selection and section assignment — the LLM's output is the dominant input. The importance rating folds into the score as `(importance − 5.5) × 5`, contributing roughly ±23 on top of base signals that cap around +75; that's large enough to flip pages across the primary (≥ 40) and optional (15–39) thresholds (constants in `lib/crawler/enrich/score.ts`). Section names come from the LLM's suggestion first, with path-regex inference only as a fallback when the LLM didn't supply one. So calling inclusion or grouping "deterministic" would be wrong — the thresholds and grouping rules are deterministic, but the numbers and hints they operate on are not.
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

Three long-running routes (`app/api/p/route.ts`, `app/api/monitor/route.ts`, `app/api/worker/crawl/route.ts`) are given `maxDuration: 300s` in `vercel.json`; everything else uses the default. Crawl work itself is capped to `270s` (`crawler.PIPELINE_BUDGET_MS`) so there is time to write a clean `failed` state if the budget is exhausted.

---

## 3. Data Model

Three tables. The canonical DDL, indexes, and RLS setup (enablement on all three + the single `user_requests` policy) are in `supabase/migration.sql`; per-table rationale is in [`SECURITY.md §4`](./SECURITY.md#4-authentication-and-authorization). This section covers the shape and why.

### `pages` — canonical per-URL cache

One row per canonical URL. Holds the final `llms.txt` (`result`), the scored page list the explorer UI consumes (`crawled_pages` JSONB), LLM-extracted site metadata (`site_name`, `genre`), and the monitoring state (`monitored`, `last_checked_at`, `last_requested_at`, `content_signature`).

Two identifiers, on purpose: `url` (PRIMARY KEY) is the dedup key — FK target for `jobs` / `user_requests` and the crawl pipeline's cache key. `id` (UUID) is the user-facing identifier — every `/p/{id}` URL in the product routes through it, stable across re-crawls, so bookmarked and shared URLs keep working through monitor refreshes.

Every page is monitored by default; the cron unsets the flag on pages nobody has touched in the last `monitor.STALE_DAYS`, keeping the daily sweep bounded.

### `jobs` — one row per crawl execution

Holds status, progress, errors, and timestamps for a single crawl run. Status transitions: `pending → crawling → enriching → scoring → assembling → {complete | partial | failed}`, enforced by a `CHECK` constraint so a typo in client code can't corrupt the state machine.

`jobs` is a history, not a cache. Every crawl — user submission, TTL refresh, monitor-triggered re-crawl — creates a new row. The *result* lives on the matching `pages` row. `pages.id` is the stable result identifier — `/p/{id}` (the cached-result permalink) routes against it, unchanged across re-crawls. `jobs.id` is per-execution and powers `/jobs/{id}` (the live-progress view), which redirects to `/p/{pageId}` once the job goes terminal.

`created_by` (TEXT, CHECK-constrained) records the principal that initiated the job, in the same prefixed shape the rate limiter uses (`lib/upstash/rateLimit.ts`): `user:<uuid>` for signed-in submissions via POST /api/p, `ip:<addr>` for anon submissions, `cron` for monitor-cron re-crawls, plus a legacy `user` value for rows from before the principal format was added. The column is internal — never returned by any API route — and is meant for analytics / abuse triage queries against Supabase directly.

### `user_requests` — per-user dashboard history

One row per `(user_id, page_url)` pair recording that a signed-in user asked for that URL. Feeds the dashboard list and the zip download. RLS on this table is what stops one user from reading another user's history — the privacy-critical policy because this is the only user-scoped data ever surfaced to a browser. (`jobs.created_by` carries audit-trail identity too, but it's never returned via an API; it's service-role-only.)

### Why this shape

- One `pages` row per URL means a popular URL crawls once regardless of how many users ask for it.
- `user_requests` carries no data beyond the join — no overrides, notes, tags. Deleting a request removes it from your dashboard without affecting anyone else.
- `ON DELETE CASCADE` from `pages(url)` reaches through both `jobs` and `user_requests` so a future cleanup could drop a page cleanly.

---

## 4. Auth & User Model

Supabase Auth handles identity: GitHub and Google OAuth, SSR session cookies, server-side user lookup from the cookie. `lib/supabase/{server,client}.ts` hold the factories; `middleware.ts` keeps the session cookie fresh on the routes that use it and gates `/dashboard`. Full middleware matcher + session-refresh rationale in [`SECURITY.md §4`](./SECURITY.md#4-authentication-and-authorization).

The app is **optionally-authenticated** on the main flow. Anyone can generate an `llms.txt` without signing in. Sign-in unlocks:

- `/dashboard` (history list)
- Higher rate limits (see [`SECURITY.md §2`](./SECURITY.md#2-abuse--rate-limiting) for the bucket table)
- `GET /api/pages` + `GET /api/pages/download` (history API + zip export)
- Remembering what you've asked for across devices

There is no preview/full mode distinction. Every crawl uses the same budget. The only difference an account makes is how many crawls per hour you can request and whether the result lands in your history.

---

## 5. API Surface

All routes live under `/app/api`.

| Method & path | Auth | Purpose |
|---|---|---|
| `POST /api/p` | Optional | Kick off a crawl, or return the page's UUID if one is already running / cached. Response body: `{ page_id, job_id?, cached }`. `page_id` is the `pages.id` UUID — `/p/{page_id}` is always the same URL for the same canonical page. `job_id` is set whenever a crawl is in flight (new dispatch or attached to an existing in-flight one); the client routes to `/jobs/{job_id}` for live progress. Cache hits omit `job_id` and the client routes straight to `/p/{page_id}`. |
| `GET /api/p/[id]` | Public | Page-state read by `pages.id`. Returns status / progress / error and, when terminal, the cached `result` + `crawled_pages`, plus `last_checked_at` for the freshness label. The dashboard polls this endpoint for in-flight rows in the user's history (the `/p/{id}` RSC itself reads `getPageById` from the store directly). Terminal responses get a long edge-cache; in-flight returns `no-store`. |
| `GET /api/jobs/[id]` | Public | Live job status by `jobs.id`. Returns `{ id, pageId, pageUrl, status, progress, error, ... }` — no `result`, kept lightweight for poll traffic. The `/jobs/{id}` page polls this every `ui.POLL_INTERVAL_MS` and `router.replace`s to `/p/{pageId}` on terminal success. Terminal responses are short-cached; in-flight returns `no-store`. |
| `GET /api/p/request?pageUrl=…` | Optional | Returns `{ inHistory: boolean }` for the signed-in user; anon callers always get `false`. Powers the result page's conditional "Add to dashboard" button. |
| `POST /api/p/request?pageUrl=…` | Required | Upsert a `user_requests` row for the signed-in user — used from the result page when a user wants to save a shared URL they didn't originally submit. No crawl is triggered. 404s if the URL isn't already in `pages`. Origin-checked. |
| `DELETE /api/p/request?pageUrl=…` | Required | Remove a page from the signed-in user's history. |
| `GET /api/pages?offset&limit` | Required | Paginated dashboard list. |
| `GET /api/pages/download` | Required | Zip of every completed page in the user's history. |
| `GET /api/monitor` | Bearer `CRON_SECRET` | Vercel Cron target; runs the daily monitor sweep. |
| `POST /api/worker/crawl` | QStash signature | QStash pushes here with `{ jobId, url }`; the route synchronously runs `runCrawlPipeline`. Signature-verified via `verifySignatureAppRouter` from `@upstash/qstash/nextjs`, body shape-checked (UUID + http(s)) on top. |
| `GET /auth/callback` | — | OAuth return path, exchanges code for session. |

### `POST /api/p` — the hot path

Every new-crawl request lands here. The flow is four gates then a branch:

1. **Origin check** (`isAllowedOrigin`) — rejects cross-origin POSTs; requests with no `Origin` header pass through (not CSRF vectors). Defence-in-depth on top of the `SameSite=Lax` session cookie.
2. **URL parse + validation** — reject missing / non-string / over-length / non-http(s) URLs with `400`.
3. **SSRF gate** (`assertSafeUrl`) — runs *before* rate-limit consumption, so loopback / RFC1918 / metadata-IP / non-default-port / DNS-unresolvable URLs never reach the DB or a token-bucket slot. `createJob` re-runs this check in defence-in-depth, which guarantees no unsafe URL can ever persist a `pages` or `jobs` row regardless of how the caller reached `createJob`.
4. **SUBMIT rate-limit** — keyed by `user.id` or client IP. Denial → `429 { reason: "submit_flood", retryAfterSec, signInPrompt }`. NEW_CRAWL is charged separately, below, only when the request actually dispatches a crawl. See [`SECURITY.md §2`](./SECURITY.md#2-abuse--rate-limiting) for the full bucket table.

Past the gates, the route tries to avoid work:

- **Cache / in-flight check** — the route tries up to three keys (raw, `www.`-alternate, and canonical-after-HEAD-probe) because most repeat submissions match one of the first two without paying for a HEAD request. Canonicalisation uses a dual www/non-www probe (via `resolveCanonicalUrl` in `lib/crawler/net/canonicalUrl.ts`) and strips tracking + per-request session/OAuth tokens so the cache key stays stable across resubmissions. A cached terminal hit returns `{ page_id, cached: true }`; an in-flight attach returns `{ page_id, job_id, cached: false }` so the client can route to `/jobs/{job_id}` for the live view.
- **TTL-stale signature check** — if a cached row exists but is past `PAGE_TTL_HOURS`, run the same signature probe the monitor cron uses (`detectChange` → sitemap + homepage hash). `recordMonitorCheck` stamps `last_checked_at` regardless of outcome, and if the signature hasn't drifted the existing result is returned as a cache hit without burning NEW_CRAWL budget. Drift or an uncomputable signature falls through to the new-crawl branch.
- **New crawl** — on a full miss (or on drift from the branch above): charge the NEW_CRAWL bucket, insert a `jobs` row, and call `enqueueCrawl(jobId, url)` (QStash in prod, `waitUntil` fallback in dev). The HTTP response returns immediately; the actual pipeline runs later in the worker (`app/api/worker/crawl/route.ts` under QStash, the caller's own Fluid Compute instance under the dev fallback).

On every branch — cache hit, in-flight attach, TTL-stale-unchanged, new crawl — `bumpPageRequest` fires and a signed-in caller gets an `upsertUserRequest` written to their dashboard history (idempotent against `UNIQUE(user_id, page_url)`).

### `GET /api/p/[id]` — page-state read

The public read endpoint for the cached result. The dashboard polls it for in-flight rows in the user's history; the `/p/{id}` RSC itself reads `getPageById` from the store directly rather than going through this route. The live-progress poll path is `GET /api/jobs/[id]`, below. The route:

- Looks up the page by UUID, joining to the latest job for status/progress/error and (when terminal) the cached `result` + `crawled_pages`. The route runs `getPageStatusById` first for the cheap path and only falls back to `getPageById` (which pulls `result` + `crawled_pages`) when the status is terminal — in-flight polls never pay for the heavy columns.
- Does not touch `last_requested_at` — the read is pure. `bumpPageRequest` fires on every `POST /api/p` branch and on the `/p/[id]` RSC render for non-failed pages (failed pages are intentionally left to age out of the monitor rotation).
- Scrubs the `error` field (see [`SECURITY.md §9`](./SECURITY.md#9-error-information-disclosure)) so user-facing text doesn't leak resolved IPs or SSRF detail.
- Sets a long public Cache-Control on terminal responses so Vercel's CDN handles repeat reads. Freshness comes from **write-side invalidation** — `updateJob` calls `revalidatePath` on the page's `/api/p/{id}` whenever a terminal result is written — rather than the TTL. The TTL is a safety net for dropped revalidations, schema changes, or direct-SQL writes; the common path never waits for it. In-flight returns `no-store`.

### `GET /api/jobs/[id]` — the live-poll target

The `/jobs/{id}` progress view polls this every `ui.POLL_INTERVAL_MS`. Returns lightweight job state (status / progress / error / `pageId` / `pageUrl`) — no `result` payload, since the page `router.replace`s to `/p/{pageId}` the moment the job hits a terminal-success status (`complete` / `partial`). On `failed` it stays on `/jobs/{id}` so the user sees the scrubbed error and a "try another URL" CTA. Terminal responses are short-cached at the edge (`s-maxage=60`) since the client navigates away on its next poll; in-flight returns `no-store`. Errors are scrubbed via the same `scrubError()` used by `/api/p/[id]`.

### `GET /api/monitor` — daily sweep

See §8.

---

## 6. Crawl Pipeline

`runCrawlPipeline(jobId, targetUrl)` in `lib/crawler/pipeline.ts` is the entry point. For the stage-by-stage narrative (discovery → enrichment → scoring → assembly) see [`SYSTEM-DESIGN.md §3`](./SYSTEM-DESIGN.md#3-pipeline-stages-what-the-progress-ui-shows); this section covers the pipeline decisions that narrative doesn't: where the LLM/deterministic line is drawn, how scoring selects pages, how the pipeline self-terminates, and the SPA fallback.

### Where the LLM line is drawn

Per the design principle in §1: every taste call is the LLM's (which URLs to crawl under the 25-page cap, per-page importance + section label, brand name, site preamble), every mechanical call is deterministic (robots/sitemap parsing, fetch + extraction, SSRF validation, scoring math, markdown assembly).

The LLM does **not** decide:
- **Final link ordering inside a section** — deterministic sort by score descending.
- **File assembly** — `assembleFile()` is pure text construction.
- **Whether a page lands in Optional** — pages below the primary threshold are always Optional (or excluded below the include threshold), regardless of what section the LLM suggested.

### Scoring and selection

`scorePages` produces a numeric score per page by combining structural quality signals (description presence, `.md` sibling, JSON-LD, headings, body length — all additive) with URL-shape anti-patterns (pagination, print/export, tag/category/archive/author paths, plus affiliate / sponsored / deals patterns — all subtractive) and the LLM's importance rating folded in as `(importance − 5.5) × 5`, giving roughly a ±23-point swing on top of base signals that cap around +75. There's also a soft off-primary-language penalty so locale duplicates sink below their primary-language twins (see `language.ts`). The deals / coupons / promotions penalty is genre-aware: skipped on `ecommerce_store` and `marketplace` sites where those paths are first-party catalogue (Best Buy, Amazon), applied everywhere else where they're affiliate-revenue ads (foxnews.com/deals/X).

Three thresholds, all in `lib/crawler/enrich/score.ts` (`PRIMARY_SCORE_THRESHOLD`, `INCLUDE_SCORE_THRESHOLD`):

- **Primary** (high score) — page lands under its LLM-hinted section (with path-regex inference as fallback if the LLM didn't supply one).
- **Optional** (middling score) — page lands under `## Optional`.
- **Excluded** (below include threshold) — dropped.

`filterAndSelectPages` then dedupes by hostname+path (so `/foo` and `/foo/index.html` collapse), excludes the base-domain homepage (redundant with the H1), and caps the output at 50 Primary + 10 Optional. A single-page-site rescue puts the homepage back in Optional if both buckets would otherwise be empty — so one-page SPAs still produce a valid (minimal) file rather than failing.

Before any of this, the URL discovery stage runs `dropParametricFanout` (`lib/crawler/net/url.ts`) as a deterministic backstop. When a single first-path-segment hosts ≥ `crawler.FANOUT_DROP_THRESHOLD` (20) depth-2 leaves in the candidate list — e.g. `/city/{slug}` × hundreds, `/store/{id}` × thousands, `/listing/{slug}` × millions — every URL under that prefix is dropped, including its deeper descendants. The depth-1 parent index page (`/city`, `/store`, `/location`) lives in a different bucket and survives, which is what an LLM consumer of llms.txt actually needs from a directory-of-similar-items section. Detection counts ONLY depth-2 leaves toward the threshold so a deep docs hierarchy (`/docs/{cat}/{topic}` × hundreds at depth 3+) isn't mistaken for fan-out — a real docs site has only a small number of depth-2 categories. The LLM ranker's prompt also instructs it to drop fan-out, but the LLM is too unreliable on this one (it scores each fan-out page individually, where each looks legitimate), so the deterministic filter runs first.

Section ordering in the assembled file (`assemble.ts` → `groupBySection`) sorts by an **effective score** — `avgPageScore + (sectionPriority − 50) × 0.3`. The LLM's per-page `importance` carries the bulk of the judgment (the `enrichBatch` prompt scores structural pages at 8–10 and catalogue items at 4–7), but in practice the model bunches its scores in the middle, so the small additive boost from `SECTION_PRIORITY` lets a foundational-named section (About → +15, Services → +12, Support → +3) edge out a slightly-higher-scored catalogue section. The boost is calibrated so it flips small avg-score gaps but doesn't override a genuinely-stronger catalogue. The `SECTION_PRIORITY` table only lists labels with stable cross-genre meaning in the llms.txt shape (About, Pricing, Docs, Support, etc.) and never includes catalogue-shaped section nouns or genre-specific terms, so an LLM-invented section name gets the neutral default (50). After this sort, the LLM final-review pass (§7 #6) can override the order entirely with an explicit `section_order`. Optional is always last.

Then on top of that — once the file is assembled — the LLM final-review pass (`llmFinalReview`, §7 #6) can both reshape the section set (by `moves` that reassign entries between sections, including merging singletons into a topically-adjacent larger section, with new section names allowed) and override the ordering entirely by returning an explicit `section_order`. Moves are applied before assembly re-runs, and `section_order` validates against the post-move section set. That's what catches the case where the avg-score sort still got it wrong despite the boost, e.g. on a site whose catalogue is so dominant that no boost wins, or where per-page enrichment fragmented related entries across multiple thin headers.

(`scorePages` takes a `genre` argument it currently ignores — kept on the signature so adding genre-weighted modifiers later doesn't churn callers. Genre is used by the LLM prompts + preamble.)

### Terminal status

At the end of a crawl the job flips to one of three terminal states:

- **`failed`** — no pages were successfully fetched, OR both output buckets (primary + optional) are empty. The second case catches SPAs the detector missed whose Puppeteer render also produced nothing: better a clean failure than a degenerate `# <SiteName>` stub.
- **`partial`** — at least a handful of URLs were fetched but more than half of the attempts failed along the way. Intentionally gated at ≥ 5 attempts so a 2-page site with one timeout doesn't read as partial.
- **`complete`** — everything else.

### Self-termination

The pipeline runs under a `PIPELINE_BUDGET_MS` (currently 270 s — see `lib/config.ts`) timeout driven by an `AbortController`. A `setTimeout(ac.abort, PIPELINE_BUDGET_MS)` fires the signal; the inner pipeline calls `signal.throwIfAborted()` at each stage boundary and bails as soon as the budget is gone. The outer `catch` flips the job to `failed` with a clean error. The signal-based design ensures the inner pipeline actually stops on timeout — a `Promise.race` would return promptly but leave the inner work running orphaned in the background, still burning compute + Anthropic spend on a result no one is waiting for.

### SPA handling

`isSpaHtml(html, bodyExcerpt)` flags a response as SPA when the HTML is large but visible text is tiny, when framework markers (`data-reactroot`, `ng-app`, unexpanded `{{ … }}`) are present, or when the plain fetch was blocked entirely. On an SPA signal the pipeline launches headless Chromium (`@sparticuz/chromium` on Vercel, bundled `puppeteer` locally) with resource-blocking on for images/fonts/media, and uses the rendered DOM for both extraction and link discovery for the rest of the crawl. Puppeteer is single-threaded within a job, so worker-pool concurrency is forced to 1 when the browser path is active. The gate is one-way: once the pipeline falls back to Chromium it stays there, because a plain fetch that failed on the homepage is overwhelmingly likely to fail on subpages too.

### External references

Same-domain filtering on the crawl queue is correct (a single outbound anchor would otherwise give the crawler permission to roam the web), but leaves the output with no cross-origin entries even when the site explicitly links to its own spec, upstream docs, or closely related projects. `resolveExternalReferences` bridges that gap: homepage outbound anchors only, LLM-ranked down to `crawler.EXTERNAL_REFS_MAX_KEEP`, each fetched exactly once for metadata (no link discovery), merged into scoring alongside internal pages so the LLM can place them in whatever section fits. SSRF is preserved — `fetchPage` still goes through `safeFetch` with per-hop validation.

---

## 7. LLM Usage

Four call sites per crawl, all pinned to the model in `llm.MODEL`. Reduced from six in an earlier iteration: ranking and homepage analysis were each two separate calls; merging halved Anthropic round trips per crawl, which matters for staying inside the per-tier RPM budget when monitor-cron fan-out spikes.

1. **`rankSiteUrls`** — one call, two ranking jobs. Picks the most valuable internal URLs to crawl from the discovery candidate set AND curates which homepage outbound anchors are worth including as external references. Both jobs share the same homepage context, so combining cuts a round trip vs. running them separately. Skipped only when both lists are too small to benefit from ranking. Caps in `lib/config.ts`.
2. **`enrichBatch`** (via `llmEnrichPages`) — returns `importance` (1–10), `section` label, and `description` per page. `ENRICH_BATCH_SIZE` is sized to match `MAX_PAGES`, so a typical full-budget crawl ships in one batch / one round trip; the per-batch parallel-fan-out path remains in `llmEnrichPages` as a safety mechanism if either cap is raised in the future. `section` is the primary signal for pages above the primary threshold; the path-regex inference only runs when the LLM didn't return a usable section. Pages below the primary threshold always land in `Optional` regardless of what the LLM said.
3. **`analyzeSiteHomepage`** — one call, two analysis jobs. Picks the brand name from raw HTML candidates AND writes the 1–3 sentence intro paragraph. Both jobs share homepage signals, so combining cuts a round trip. Falls back to the deterministic site-name guess only when the LLM returns a name that fails sanitization. If the model isn't preamble-confident (explicit flag in the response schema), the file ships without a preamble rather than with refusal prose.
4. **`llmFinalReview`** — runs after `assembleFile` produces a draft markdown. The model is given the **actual full file** (H1, summary, preamble, every section header, every entry's title / URL / description) and returns `{ drop_urls, moves, section_order, relabel, redescribe }`. Reading the whole assembled file at once lets it catch noise per-page enrichment can't see — login redirects, marketing-tracking-param URLs, individual catalogue items the section index already covers, descriptions that repeat the preamble — reassign entries that landed under the wrong header (a "Player Inclusion Coalition" entry placed under About should be in Community), consolidate fragmented sections by moving singleton entries into a topically-adjacent larger section (target name may be an existing section or a new merged label), reorder sections when the avg-score sort put a foundational one (About, Pricing, Docs) below a catalogue, rewrite link labels that came out awkwardly (run-together URL slugs like "Getstarted" → "Get Started", URL-derived fallbacks like "Page1"), and redescribe entries whose description reads strangely next to its label (grammatical errors, vague marketing prose, structure references, label-repeating openings, off-language). Moves + description rewrites are applied first so any new section names they introduce are eligible to appear in `section_order` and so the re-rendered draft contains the corrected text. Drops, moves, relabels, and redescribes are matched via a rendered-URL → canonical-URL alias map so the model can return URLs in whatever form they appear inside the `[..](URL)` of the draft. A description rewrite bumps `descriptionProvenance` to `"llm"` so `assemble.ts` keeps rendering the description (it gates render on provenance ≠ `"none"`). A parse error or "no edits" response leaves the draft untouched; transport failures throw `LlmUnavailableError` and surface the job as `failed`.

Every call site is required: a transport failure (no API key, billing exhausted, exhausted retries on 5xx / 429, network error) throws `LlmUnavailableError`, which the outer catch in `runPipelineInner` converts to a `failed` job with a user-facing "AI service is unavailable" message. Producing a deterministic-only file when the AI was unavailable would mislabel a degraded result as a real one — better to surface the failure so the user can retry.

The boundaries the LLM does and does not cross are in §6 ("Where the LLM line is drawn"). One consequence worth flagging: every crawl is a little non-deterministic. Two runs on the same site can produce different section labels, descriptions, or priority orderings, all of them valid. That's the design, not a bug.

### Prompt injection defenses

Every chunk of crawled content is sanitised before injection, wrapped in an explicit `<untrusted_pages>` fence the model is told to treat as data, and every LLM output field is re-validated against a strict shape before downstream code consumes it. Full mechanism (sanitizer details, fence structure, output allowlists) in [`SECURITY.md §3`](./SECURITY.md#3-prompt-injection). The net effect: an attacker can make the LLM return garbage for its own page's description, but they can't poison a different page's output or escape the shape.

---

## 8. Monitoring

`GET /api/monitor` runs on a Vercel Cron schedule, authenticated by a timing-safe compare against `CRON_SECRET`. There is no monitor state machine — monitoring is just a cron job that compares signatures and triggers re-crawls.

Each invocation does three things, in order:

1. **Force-fail stuck jobs** — any job wedged in a non-terminal status past the stuck-job window is flipped to `failed`. Must run before `getActiveJobForUrl` elsewhere would treat those rows as phantom in-flight work.
2. **Retire stale pages** — any page not requested in the last `monitor.STALE_DAYS` has `monitored` set to `false`, bounding the working set to URLs people are actually using.
3. **Signature sweep** — pull the next batch of monitored pages (oldest-checked first, same-host politeness delay between hits), compute a signature over the site (sitemap URL set + normalised homepage HTML, hashed together), and dispatch a re-crawl if the signature drifted from the stored one. First-ever check just records the baseline without triggering a crawl; transient fetch failures don't overwrite the stored signature.

Re-crawls flow through the same `enqueueCrawl` path as user submissions. A successful crawl stamps `last_checked_at` itself, so the dashboard shows "Refreshed just now" immediately after first generation rather than dangling on "Awaiting check" until the next cron tick.

Narrower than the crawl pipeline by design: the monitor only fetches `{origin}/sitemap.xml` (not robots-declared sitemaps or `/sitemap_index.xml` indirection), because it runs on every monitored URL every tick and indirection would balloon the cost. Thresholds and sizing (`STALE_DAYS`, `BATCH_SIZE`, `SAME_HOST_DELAY_MS`, `STUCK_JOB_AFTER_MS`) live in `lib/config.ts` → `monitor`.

### Why stateless

The product promise is simple: the cached result should not drift. A single daily sweep that compares signatures and dispatches re-crawls hits that goal in ~30 lines, with no `monitors` / `monitor_runs` tables, no per-user frequency state, and no delivery state machine. The richer story (per-user schedules, notification email, webhook delivery with HMAC, delivery-attempt tracking) is a separate product and only worth building once users ask for it — by then the requirements will be clearer than guessing them up front.

---

## 9. Frontend

Five routes: `/` (landing with the URL input), `/dashboard` (signed-in history, infinite-scroll), `/jobs/[id]` (live crawl progress), `/p/[id]` (cached-result permalink), `/login` (OAuth picker). Progress and result are split on purpose: `/p/{id}` is a pure permalink that always renders the most-recently-good `llms.txt` for the page (no polling, no progress UI); `/jobs/{id}` polls `/api/jobs/[id]` every `ui.POLL_INTERVAL_MS` and `router.replace`s to `/p/{pageId}` on terminal success. On `failed` it stays put so the user sees the scrubbed error and a "try another URL" CTA. Cache-miss submissions and Refresh-button clicks that dispatch a fresh crawl land on `/jobs/{id}`; cache-hit submissions and direct visits to a permalink land on `/p/{id}`. The result page validates `llms.txt` against the spec in-browser and surfaces a "Spec valid" / "N issues" badge; signed-in viewers on a shared result URL they don't yet own see an "Add to Dashboard" button that saves the URL without re-crawling.

If `/p/{id}` is hit before the page has ever produced a result (only-ever-failed crawls, or the rare race where a permalink is visited before the first crawl finishes), the RSC redirects to `/jobs/{activeJobId}` if a job is in flight, otherwise 404s.

One client-side-only behaviour worth knowing about:

- **Poll circuit-breaker** — on `/jobs/{id}`, after several consecutive poll failures the page stops polling and shows a "lost connection" banner with a manual reload. Prevents a dead backend from hammering the API.

Everything else (component names, state-management details, specific element labels) is code-level — see the files under `app/`.

---

## 10. Security Model

Full discussion in [`SECURITY.md`](./SECURITY.md). Summary:

### SSRF

Every outbound fetch goes through `assertSafeUrl` (rejects non-http(s), non-default ports, and any private / loopback / link-local / metadata IP across v4 and v6) wrapped in a manual-redirect fetcher that re-validates on every hop. The Puppeteer path calls it directly before each `page.goto`. Full blocked-range list and the DNS-rebinding TOCTOU caveat live in [`SECURITY.md §1`](./SECURITY.md#1-ssrf-server-side-request-forgery).

### Rate limiting

Two token buckets (SUBMIT + NEW_CRAWL) per principal on `POST /api/p`; Upstash Redis in production, in-memory fallback for dev. Full bucket table, backend selection, fail-open rationale, and denial response shape live in [`SECURITY.md §2`](./SECURITY.md#2-abuse--rate-limiting). All four bucket sizes are tunable in `lib/config.ts` → `rateLimit`.

### Prompt injection

See §7. Neutering before injection + schema-validated output + hard length caps. A malicious page can make the LLM return garbage for its own description; it cannot escape the shape or poison a different page's output.

### RLS

Service-role key stays server-side (loaded via `requireEnv("SUPABASE_SERVICE_ROLE_KEY")` inside `getClient()` in `lib/store.ts`). Client never sees it. RLS's default-deny locks everything on `pages` and `jobs` to the service-role key: the browser-bundled anon key has no grants, so a hacker who lifts it can't bulk-read either table directly. `user_requests` carries the one explicit policy (`auth.uid() = user_id`) to keep per-user history private. Full RLS discussion in [`SECURITY.md §4`](./SECURITY.md#4-authentication-and-authorization).

### Headers

`next.config.ts` sets CSP, `X-Frame-Options`, `X-Content-Type-Options`, `Referrer-Policy`, and `Permissions-Policy` on every response. Exact directives + rationale per header (including the documented `'unsafe-inline'` / `'unsafe-eval'` trade-off for Next.js's RSC bootstrap) live in [`SECURITY.md §7`](./SECURITY.md#7-http-security-headers).

### Cron authentication

`GET /api/monitor` checks the `Authorization: Bearer <token>` header against `CRON_SECRET` with a timing-safe compare. Vercel Cron sets this header automatically.

### Secret handling

No API key or token ever reaches the log stream. Error messages embedded in job rows are scrubbed before being returned to `/api/p/[id]` — resolved IPs and SSRF-specific detail are stripped so an attacker can't use the error text as a port scanner.

---

## 11. Config Surface

Every constant that might plausibly be adjusted for business or UX reasons lives in `lib/config.ts`, grouped by domain. One source of truth, one file to grep when you need to see what a number currently is. The groups:

- **`crawler`** — crawl bounds: page count, link-follow depth, worker concurrency, politeness delays, per-fetch timeouts, byte caps on responses and sitemaps, pipeline wall-clock budget, external-ref cap.
- **`llm`** — the pinned Claude model, Anthropic SDK retry/timeout tuning, enrichment batch size, URL-ranker caps, sanitizer length limits.
- **`api`** — input-side caps on the public routes: URL length, pagination defaults/ceiling, zip-export max entries.
- **`rateLimit`** — token-bucket configs for `POST /api/p` (SUBMIT + NEW_CRAWL, split anon/auth), the `/api/monitor` anti-amplification bucket, and the `/api/pages/download` zip cap. Rationale in [`SECURITY.md §2`](./SECURITY.md#2-abuse--rate-limiting).
- **`monitor`** — cron sweep sizing: stale-page cutoff in days, batch size per tick, same-host politeness delay, stuck-job timeout.
- **`ui`** — client-side timing: poll cadence, poll-failure circuit-breaker threshold, live-step minimum dwell, freshness-label tick interval.

Code reads these constants by name — no hardcoded magic numbers on the hot paths — so tuning a value in one place propagates everywhere it matters.

Secrets come from environment variables, not this file. `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, and `SUPABASE_SERVICE_ROLE_KEY` load through `lib/env.ts`'s `requireEnv()` helper, which fails fast on a missing value. `CRON_SECRET` is read directly via `process.env` because the cron endpoint fails closed when it's absent. `ANTHROPIC_API_KEY` is also read at call time and its absence raises `LlmUnavailableError` from the first LLM call site — the pipeline surfaces this as a `failed` job with a user-visible message, since shipping a heuristic-only file labelled as a real result would mislead the user.

---

## 12. Key Design Decisions & Trade-offs

### Globally-shared `pages` row

*Trade-off:* No per-user customization, no user-scoped exclusions, no private results. *Why:* the product is "generate a valid `llms.txt` for a public website"; there's no meaningful notion of a user-private version. Sharing the row means the same URL crawls once no matter how many users ask for it, and the dashboard is effectively free to render.

### Stateless monitoring

*Trade-off:* No per-user frequency preferences, no webhook delivery, no per-run diff storage. *Why:* the product promise is "your cached result won't drift", not "you'll be notified of every change". A daily sweep with a signature compare is ~30 lines; a full monitor system is a separate product.

### Single pinned LLM model

*Trade-off:* No per-call model selection, no fallback tier. *Why:* Haiku is fast and cheap enough for description writing; a swap is one line in `lib/config.ts`. Anything fancier (Sonnet for the preamble, Haiku for pages) adds complexity without a proven quality delta on this task.

### Crawl execution backend

*Trade-off:* The same `enqueueCrawl(jobId, url)` helper in `lib/upstash/jobQueue.ts` has two backends chosen at call time. *Why:* production (Vercel + `QSTASH_TOKEN` set) publishes to QStash, which then POSTs the signed job to `/api/worker/crawl`; the worker runs the pipeline synchronously so QStash's retry-on-non-2xx semantics provide real mid-pipeline durability. Local dev (no `QSTASH_TOKEN`) uses an in-process path — `waitUntil(runCrawlPipeline(...))` in the caller's own Fluid Compute instance — so `npm run dev` works without a publicly reachable callback URL. The caller-side code path is one line in both cases (`await enqueueCrawl(id, url)`).

### Rate limiter backend

*Trade-off:* The same module has an in-memory path (dev) and a Redis path (prod) selected by env. *Why:* local dev shouldn't require a network dependency, and the interface is identical in both paths so callers are unaffected. Upstash is the production target because Vercel KV is deprecated and Upstash Redis is the Marketplace-recommended replacement; the `@upstash/ratelimit` library wraps the right Lua-atomic token-bucket primitives.

### Page UUID as access token

*Trade-off:* Anyone with a `/p/{id}` URL can see that page's current `llms.txt` result and crawl status without signing in. *Why:* the UUID is v4 and non-enumerable, and shareable result URLs are a feature of the product. The *history* — which URLs a given user has asked for — stays private via RLS on `user_requests`, and bulk enumeration of `pages` via a leaked anon key is blocked by RLS default-deny (no anon-accessible policies on `pages` or `jobs`).

### LLM ranks + deterministic thresholds

*Trade-off:* Two systems to tune (LLM importance + hand-weighted signals). *Why:* the LLM has full site context and is much better at "is this the right page to show"; the deterministic signals are much better at "is this page actually parseable and link-worthy". Combining them is more robust than either alone.

### No Puppeteer for non-SPA sites

*Trade-off:* Can't run any JS. *Why:* Puppeteer is 5–20× slower and requires a heavier runtime bundle. The SPA detector (`isSpaHtml`) is conservative: fall through to Puppeteer only if the plain fetch is blocked, the HTML is an empty shell, or framework markers are present.

---

## 13. What's Intentionally Deferred

The following are out of scope for the current implementation. Each is plausible for a V2, but none are required for the MVP promise.

- **User-editable overrides.** No override versioning, no persistent per-user edits to the generated file, no merge policy on re-crawl. Users who want custom output copy the result and edit it locally.
- **Update delivery.** No webhook HMAC, no email notifications, no hosted-file endpoint at `/files/:id/llms.txt`. Users are expected to host their own `/llms.txt`.
- **User-facing locale overrides.** The pipeline auto-detects the site's primary language from the homepage `<html lang>` attribute and prioritizes URLs in that language (locale-prefixed paths whose language differs are pre-filtered out of the crawl queue, and a score penalty demotes any off-primary pages that slip through). A caller-supplied override (e.g. "generate an English file for this Japanese site") isn't exposed — the auto-detected primary wins every time.
- **Per-domain global throttle across jobs.** Within a single pipeline the crawler honors `robots.txt` `Crawl-delay` via a shared cross-worker clock (capped at `MAX_CRAWL_DELAY_MS` = 10 s). Between concurrent jobs against the same target, there is no cross-job coordination, so a popular URL burst could send workers from multiple pipelines at the same host. Mitigated in practice by the 24-hour cache hit on repeat requests.
- **Integration / end-to-end test coverage.** A `node:test` suite under `tests/` (13 files, 320 tests at last count) covers the security-critical pure helpers (SSRF IP-range classifiers, URL normalisation, path-prefix capping, parametric-fan-out detection, scrubError including the LLM-unavailable scrubbing, validateLlmsTxt, robots / sitemap / spa-detection helpers, rate-limit math, file assembly, section ordering) and runs on every PR via `npm test`. The integrated paths — full crawl pipeline, RLS enforcement against a real Supabase, monitor cron, QStash delivery, the LLM-only steps, browser flows — aren't in the automated suite; they're covered by the manual playbook in [`TESTING.md`](./TESTING.md). Adding integration coverage is the next test-investment step if the project moves beyond a take-home demo.

---

## 14. Repository Layout

Organised by concern, not by file. Individual filenames drift; folder purpose doesn't.

- **`app/`** — Next.js App Router. Page routes (`/`, `/dashboard`, `/jobs/[id]`, `/p/[id]`, `/login`) plus `app/api/*` for every HTTP endpoint. `app/components/` holds cross-route UI chrome (header, user menu, confirm dialog).
- **`lib/config.ts`** — every tunable constant (see §11).
- **`lib/store.ts`** — Supabase access layer with the service-role key. Server-only — never imported into client code.
- **`lib/env.ts`**, **`lib/log.ts`** — `requireEnv()` fail-fast helper and the `debugLog` / `errorLog` pair that forward `Error` payloads to Sentry.
- **`lib/upstash/`** — external-service wrappers: `rateLimit.ts` (token-bucket limiter with Upstash Redis + in-memory dev fallback) and `jobQueue.ts` (QStash publish + `waitUntil` dev fallback).
- **`lib/supabase/`** — browser + server Supabase client factories, plus `getUser()` for server auth.
- **`lib/crawler/`** — the crawl pipeline. Organised by stage:
  - **`net/`** — URL + HTTP primitives (normalise, SSRF guard, safe-fetch with per-hop validation, bounded body reads, language detection).
  - **`discovery/`** — where pages come from (robots.txt, sitemaps, homepage fetch, SPA/Puppeteer fallback, in-page link extraction, `.md` sibling probing).
  - **`enrich/`** — turning raw pages into scored, classified data (metadata extraction, genre detection, brand-name cleanup, LLM enrichment, scoring, section assignment).
  - **`output/`** — final markdown assembly + spec validator (the latter also runs client-side on the result page).
  - `pipeline.ts` — the entry point the worker calls. `monitor.ts` — signature computation + change detection for the cron.
- **`supabase/migration.sql`** — full schema (pages, jobs, user_requests, indexes, RLS enablement + the single `user_requests` policy). Canonical.
- **`middleware.ts`** — Supabase SSR session refresh + `/dashboard` gate.
- **`next.config.ts`** — CSP and other security headers, `withSentryConfig` wrapper.
- **`vercel.json`** — `maxDuration` overrides on the long-running routes + the cron schedule.
- **Sentry init files at the repo root** (`instrumentation.ts`, `instrumentation-client.ts`, `sentry.server.config.ts`, `sentry.edge.config.ts`, `app/global-error.tsx`) — the Next.js SDK pins these names and locations; see [`OBSERVABILITY.md`](./OBSERVABILITY.md) for what each one does.

---

## 15. Callouts and Future Work

- **Concurrent cache-miss race.** `POST /api/p` checks `getActiveJobForUrl` (inside the `tryServeAt` helper) and attaches to an in-progress job if one exists, which handles sequential duplicates. But there's no DB-level lock or unique constraint between that check and the subsequent `createJob` — two truly simultaneous requests for the same uncached URL can both pass the check and both fire `runCrawlPipeline`, duplicating LLM/crawl spend. The failure mode is benign (the second pipeline's `pages` upsert harmlessly overwrites the first; user sees one result) so it's deferred for the MVP. Fix: partial unique index on `(url)` for active jobs with `ON CONFLICT DO NOTHING`, or a `SELECT ... FOR UPDATE` around the check/insert.
