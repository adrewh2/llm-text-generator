# Scaling — Phase 2 Plan

What today's architecture looks like, where it breaks first, and how
to migrate each piece. Written so a reviewer can see the ceiling of
the current design is understood without having already been hit.

---

## 1. What the platform provides today

The design leans on three Vercel Fluid Compute behaviours:

- **Warm instance reuse** — module-level state (cached clients, in-memory fallbacks) survives across requests inside one instance.
- **`waitUntil`** — continues async work after the HTTP response, which is how the dev-fallback path kicks off a crawl without blocking the client.
- **Long `maxDuration`** — enough wall-clock budget for the crawl pipeline to finish and write a clean terminal state.

It's cheap and simple, and it has a real ceiling — that's the point of this doc.

---

## 2. Where the design hits walls

In approximate order of which gives first as usage grows:

| Component | Current | What breaks at scale | Fix |
|---|---|---|---|
| **Rate limiter** (`lib/upstash/rateLimit.ts`) | **Shipped.** Two-bucket token limiter (SUBMIT + NEW_CRAWL) backed by Upstash Redis in production, in-memory fallback for local dev. Full table + rationale in [`SECURITY.md §2`](./SECURITY.md#2-abuse--rate-limiting); capacities tunable in `lib/config.ts`. | Production is covered. Local dev still uses per-instance state — fine, since the fallback is only reached without the env vars. | Open follow-up: enable Upstash `analytics` on both `Ratelimit` instances so denial volume per bucket is observable in a dashboard. |
| **Crawl dispatch** (`lib/upstash/jobQueue.ts`) | **Shipped + verified in production.** QStash (at-least-once, signed webhooks) when `QSTASH_TOKEN` is set; `waitUntil(runCrawlPipeline(...))` fallback otherwise. Worker lives at `/api/worker/crawl`, verified via `verifySignatureAppRouter`. Callback target is the production alias (`VERCEL_PROJECT_PRODUCTION_URL`), not the Deployment-Protection-gated per-deployment URL. | Production runs the pipeline synchronously inside the QStash-signed worker so a mid-pipeline failure is a real retry, not a stuck row. Local dev keeps the in-process path so `npm run dev` needs no publicly reachable callback. | Open follow-up: finer-grained step functions (Inngest-style) would let a partial crawl resume after the pipeline aborts, instead of restarting from scratch on retry. Not worth it at current volume. |
| **Anthropic API rate limits** | **Shipped.** `getClient()` in `lib/crawler/enrich/llmEnrich.ts` passes `maxRetries: llm.MAX_RETRIES` (5) and `timeout: llm.CALL_TIMEOUT_MS` (60 s) to the SDK, which already retries 408 / 429 / 5xx with exponential backoff and honours `retry-after` / `x-should-retry` response headers. | A bursty minute waits through the backoff window instead of falling through to the deterministic LLM fallbacks. The 5-retry budget covers a typical Anthropic 429 burst within the pipeline budget; pathological sustained throttling still falls through to the deterministic path so the crawl completes (degraded quality, no user-visible error). | Open follow-up: when the Upstash integration supports concurrency controls (QStash Queues w/ `parallelism`), add a producer-side cap as defence-in-depth. For now the Anthropic tier is the sole concurrency ceiling — plan to upgrade tiers before traffic hits it. |
| **Puppeteer launches** | Fresh Chromium per crawl that needs SPA rendering. 2–5 s cold-start, ~500 MB memory. `SpaBrowser.close()` in `finally`. | Multiple concurrent SPA crawls on one instance OOM before they finish. The ~500 MB per browser is the hard lower bound. | Either (a) share one `SpaBrowser` across concurrent crawls with a per-page pool, or (b) offload rendering to Browserless.io / Playwright Cloud and drop the dependency. Option (b) scales further; (a) is simpler. |
| **Supabase connection pool** | One service-role client cached per Fluid instance (the `cached` singleton in `lib/store.ts` → `getClient`). PgBouncer fronts the DB on port 6543. | At many concurrent cold-start instances, PgBouncer's connection cap (varies by Supabase plan) becomes the bottleneck. Currently not a problem because instance reuse keeps the open-client count low. | Use Supabase's transaction-mode pooler endpoint — short-lived connections per query instead of one per client. Or move hot reads (`getPageByUrl`) to a read-through cache. |
| **Result + poll response caching** | **Shipped.** Two endpoints, two cache profiles. `GET /api/p/[id]` is the public cached-result read (consumed by the dashboard's in-flight row poller); terminal statuses respond `Cache-Control: public, s-maxage=86400, stale-while-revalidate=604800` (1 day fresh, 7 days SWR), and `updateJob` calls `revalidatePath('/api/p/{pageId}')` on terminal-result writes so monitor re-crawls invalidate the cached response immediately. `GET /api/jobs/[id]` is the live-poll target on `/jobs/{id}`: it returns `no-store` while the job is in flight and `s-maxage=60` once terminal (the `/jobs/{id}` client redirects away on its next poll). In-flight polls do the cheapest possible work — the route is a pure read with no `bumpPageRequest`, and returns lightweight job state only (no `result` / `crawled_pages`). | In-flight reads still hit Postgres on every poll — one read per concurrent active watcher of `/jobs/{id}`. Multiplier is concurrent-watcher count. Poll cadence is `ui.POLL_INTERVAL_MS` (5 s) — progress counts only tick every few seconds during an active crawl, so a 5 s cadence still feels live while keeping in-flight DB read pressure low. | Open follow-up: short-TTL (~1 s) Redis cache on in-flight job status if concurrent-watcher count per crawl ever becomes a DB-load concern. Collapses N watchers of the same in-flight crawl to ~1 DB read per second. |
| **Monitor cron throughput** | 200 pages per invocation, sequential with 400 ms same-host delays, daily (Vercel Hobby-plan ceiling). Also force-fails stuck jobs past `STUCK_JOB_AFTER_MS` = 15 min at the head of each run. | At ~1 M monitored URLs the cron can't check them all in a day, let alone in one 300 s invocation. | Tighten the schedule to hourly once on Pro plan, move to a sharded cron (multiple invocations per day, each handling a URL-hash range), or enqueue signature checks onto the queue (above) so they fan out across workers. |
| **Zip download build** (`/api/pages/download`) | Synchronous: the route fetches up to 500 page results, builds a `JSZip` in memory with DEFLATE, and streams the bytes back in the response. Rate-limited to 1 / 24 h per user. | Large user histories → slow request, a Fluid Compute slot held for the full build, and the zip body re-transferred through a function on every click. At ~500 entries × ~30 KB each the zip is fine today, but any growth in `DOWNLOAD_MAX_ENTRIES` or per-page body size runs into the 300 s timeout and function-time cost. | Move the build off the request path: `POST /api/pages/download` enqueues a QStash job and returns 202. A new `/api/worker/zip-build` worker fetches results, builds the zip, uploads it to **Vercel Blob** (private, ~24 h expiry), and emails the signed URL via Resend. The request route stops carrying the bytes — Blob + CDN do — and the signed URL is the delivery mechanism. User email is already on the Supabase session (`user.email`); no new identity work. Trade-off is async UX (wait for email instead of instant download); a reasonable product rule is "sync if fast, email if it'd take >10 s". |

### What *doesn't* need to change

- **Supabase Postgres as primary store.** Scales fine with the current indexes for another ~2 orders of magnitude of rows.
- **Globally-shared `pages` cache.** This is a *strength* at scale — one `llms.txt` per URL regardless of demand. Popular URLs become hotter cache keys, not more crawls.
- **RLS posture + service-role pattern.** RLS on all three tables with anon-deny defaults on `pages` / `jobs` and the `user_id`-scoped policy on `user_requests`; all server reads/writes go through the service-role key. No change at scale.
- **Supabase Auth, cookie-based sessions, middleware refresh.** Scales with Supabase itself.
- **Deterministic pipeline structure.** Every transformation past the LLM calls is pure-function; trivial to move behind a queue unchanged.

---

## 3. Migration sequence

Ordered by value-to-effort ratio:

1. ~~**Redis-backed rate limiter**~~ — *shipped.* One-file swap, same interface; in-memory path kept as a no-env-vars fallback for `npm run dev`.
2. ~~**Durable queue for crawl execution**~~ — *shipped* via QStash (`lib/upstash/jobQueue.ts` + `app/api/worker/crawl/route.ts`). Worker runs the pipeline synchronously so QStash's retry-on-non-2xx is real durability. Open follow-up: step-function-style checkpoints (Inngest) to resume partial crawls instead of restarting from scratch.
3. ~~**Anthropic retry wrapper**~~ — *shipped.* `@anthropic-ai/sdk` retries 408 / 429 / 5xx with exponential backoff and `retry-after` honour out of the box; `getClient()` in `lib/crawler/enrich/llmEnrich.ts` configures it with `maxRetries: 5` and `timeout: 60_000` (see `lib/config.ts` → `llm.MAX_RETRIES` / `llm.CALL_TIMEOUT_MS`). No custom wrapper required.
4. ~~**Edge-cache the cached-result endpoint**~~ — *shipped.* `GET /api/p/[id]` (the public cached-result read; consumed by the dashboard's in-flight row poller) carries `Cache-Control: public, s-maxage=86400, stale-while-revalidate=604800` on terminal statuses (1 day fresh, 7 days SWR); `updateJob` revalidates the single `/api/p/{pageId}` path for the touched page on a terminal-result write, so monitor re-crawls invalidate the CDN without waiting for TTL. The long TTL is a safety net — freshness is maintained by the worker-driven invalidation, not the expiry. The separate `GET /api/jobs/[id]` poll endpoint stays `no-store` in flight and short-cached on terminal, since the `/jobs/{id}` client redirects to `/p/{pageId}` on terminal anyway.
5. **Puppeteer pool or Browserless offload** — depends on whether SPA-heavy sites are a meaningful fraction of traffic. Revisit once production data exists. *~1–2 days when triggered.*
6. **Sharded monitor cron** — only needed past ~100 K monitored URLs. Revisit. *~1 day.*
7. **Async zip download (QStash + Blob + email)** — only needed once typical histories exceed ~100 entries or `DOWNLOAD_MAX_ENTRIES` grows past 500. Reuses the QStash worker pattern already in place for crawls; adds Vercel Blob (public or private with signed URLs) for storage and a transactional email provider (Resend via the Vercel Marketplace integration is the path of least resistance — one-click, env var injected, 3 k emails/month free tier). *~½ day for the worker + email, plus DNS setup for a verified sender domain.*

Each step is independently shippable, none depends on a later one.

---

## 4. Integration gotchas (Upstash + QStash on Vercel)

Three traps to know about when wiring Upstash + QStash into Vercel
production. Each is silent on its own — POST /api/p still returns 201,
no errors land in logs, the QStash console shows nothing — so the only
visible symptom is jobs that never advance. The current code addresses
all three, with the relevant guards called out below.

- **`debugLog` is not the channel for operational errors.** It silently
  drops non-Error payloads in production (intentional — keeps trace
  logs out of serverless output). A failed `qstash.publishJSON` thrown
  into `catch { debugLog(...) }` would therefore produce nothing
  visible. Use `errorLog` instead: it always emits, and Error / string
  payloads forward to Sentry for grouped alerting (`lib/log.ts`).

- **`QSTASH_URL` is region-specific.** `@upstash/qstash` `Client`
  defaults its `baseUrl` to `https://qstash.upstash.io` (eu-central-1);
  accounts on other regions (us-east-1, ap-southeast-1, …) get 404 from
  that endpoint, and the SDK doesn't turn the 404 into an exception, so
  publishes look successful and drop on the floor. Fix already in place:
  `lib/upstash/jobQueue.ts` passes `baseUrl: process.env.QSTASH_URL`
  through the constructor, and logs a boot-time warning when
  `QSTASH_TOKEN` is set without its sibling URL. The Upstash Vercel
  integration ships both env vars; this trap only hits a misconfigured
  setup where one is missing.

- **Per-deployment `VERCEL_URL` is gated by Deployment Protection.**
  Every deployment gets a unique hostname (e.g.
  `llm-text-generator-giaolx9n2-aesgraph.vercel.app`) that sits behind
  Vercel Auth out of the box, so QStash callbacks land on the 401 login
  page. The production alias (`llm-text-generator.vercel.app`, exposed
  as `VERCEL_PROJECT_PRODUCTION_URL`) is publicly routable.
  `resolveWorkerUrl` in `lib/upstash/jobQueue.ts` prefers that alias
  when resolving the worker callback. Preview deploys still need
  Protection disabled or a bypass token to receive callbacks.

Common thread: each failure mode is silent by default. The fixes are in
the code; the observable-logging hooks (`errorLog`, the boot-time
QSTASH_URL warning) ensure that any future drift back into one of these
states surfaces in Sentry instead of going unseen.

---

## 5. What this costs in complexity

Today's repo is a single Next.js app + one Postgres. Phase 2 adds:

- Upstash Redis — already added. Provisioned via the Vercel Marketplace integration, which auto-injects the env vars into Production + Preview.
- Upstash QStash — already added. Same Vercel integration; env vars (`QSTASH_TOKEN`, `QSTASH_CURRENT_SIGNING_KEY`, `QSTASH_NEXT_SIGNING_KEY`) injected automatically.
- Optional: Browserless — one env var if SPA rendering moves off-platform.

No new languages, no new services beyond managed SaaS. The crawler
logic itself — `pipeline.ts` and everything in `/lib/crawler` — stays
identical. Phase 2 is a migration of *where work executes*, not *what
the work does*.
