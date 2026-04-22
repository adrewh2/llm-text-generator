# Scaling — Phase 2 Plan

What today's architecture looks like, where it breaks first, and how
to migrate each piece. Written so a reviewer can see we understand the
ceiling of the current design without having already hit it.

---

## 1. What the platform gives us today

The design leans on three Vercel Fluid Compute behaviours:

- **Warm instance reuse** — module-level state (cached clients, in-memory fallbacks) survives across requests inside one instance.
- **`waitUntil`** — continues async work after the HTTP response, which is how the dev-fallback path kicks off a crawl without blocking the client.
- **Long `maxDuration`** — enough wall-clock budget for the crawl pipeline to finish and write a clean terminal state.

It's cheap and simple, and it has a real ceiling — that's the point of this doc.

---

## 2. Where we hit walls

In approximate order of which gives first as usage grows:

| Component | Current | What breaks at scale | Fix |
|---|---|---|---|
| **Rate limiter** (`lib/upstash/rateLimit.ts`) | **Shipped.** Two-bucket token limiter (SUBMIT + NEW_CRAWL) backed by Upstash Redis in production, in-memory fallback for local dev. Full table + rationale in [`SECURITY.md §2`](./SECURITY.md#2-abuse--rate-limiting); capacities tunable in `lib/config.ts`. | Production is covered. Local dev still uses per-instance state — fine, since the fallback is only reached without the env vars. | Open follow-up: enable Upstash `analytics` on both `Ratelimit` instances so denial volume per bucket is observable in a dashboard. |
| **Crawl dispatch** (`lib/upstash/jobQueue.ts`) | **Shipped + verified in production.** QStash (at-least-once, signed webhooks) when `QSTASH_TOKEN` is set; `waitUntil(runCrawlPipeline(...))` fallback otherwise. Worker lives at `/api/worker/crawl`, verified via `verifySignatureAppRouter`. Callback target is the production alias (`VERCEL_PROJECT_PRODUCTION_URL`), not the Deployment-Protection-gated per-deployment URL. | Production runs the pipeline synchronously inside the QStash-signed worker so a mid-pipeline failure is a real retry, not a stuck row. Local dev keeps the in-process path so `npm run dev` needs no publicly reachable callback. | Open follow-up: finer-grained step functions (Inngest-style) would let a partial crawl resume after the pipeline aborts, instead of restarting from scratch on retry. Not worth it at current volume. |
| **Anthropic API rate limits** | **Shipped.** `getClient()` in `lib/crawler/enrich/llmEnrich.ts` passes `maxRetries: llm.MAX_RETRIES` (5) and `timeout: llm.CALL_TIMEOUT_MS` (60 s) to the SDK, which already retries 408 / 429 / 5xx with exponential backoff and honours `retry-after` / `x-should-retry` response headers. | A bursty minute no longer produces silent quality degradation — calls wait through the backoff window instead of falling through to the deterministic defaults. The 5-retry budget gives ~30 s of total backoff per call, well inside the pipeline budget. | Open follow-up: when the Upstash integration supports concurrency controls (QStash Queues w/ `parallelism`), add a producer-side cap as defence-in-depth. For now the Anthropic tier is the sole concurrency ceiling — plan to upgrade tiers before we hit it. |
| **Puppeteer launches** | Fresh Chromium per crawl that needs SPA rendering. 2–5 s cold-start, ~500 MB memory. `SpaBrowser.close()` in `finally`. | Multiple concurrent SPA crawls on one instance OOM before they finish. The ~500 MB per browser is the hard lower bound. | Either (a) share one `SpaBrowser` across concurrent crawls with a per-page pool, or (b) offload rendering to Browserless.io / Playwright Cloud and drop the dependency. Option (b) scales further; (a) is simpler. |
| **Supabase connection pool** | One service-role client cached per Fluid instance (the `cached` singleton in `lib/store.ts` → `getClient`). PgBouncer fronts the DB on port 6543. | At many concurrent cold-start instances, PgBouncer's connection cap (varies by Supabase plan) becomes the bottleneck. Currently not a problem because instance reuse keeps the open-client count low. | Use Supabase's transaction-mode pooler endpoint — short-lived connections per query instead of one per client. Or move hot reads (`getPageByUrl`) to a read-through cache. |
| **`/api/p/[id]` response caching** | **Shipped.** Terminal statuses respond with `Cache-Control: public, s-maxage=86400, stale-while-revalidate=604800` (1 day fresh, 7 days SWR); in-flight polls stay `no-store` so progress remains live. Freshness is driven by the worker, not the TTL: `updateJob` calls `revalidatePath('/api/p/{pageId}')` on a terminal-result write, so monitor re-crawls invalidate the cached response immediately. The long TTL is the safety net (rare `revalidatePath` drops, deploys with schema changes, direct SQL writes). In-flight polls also do the cheapest possible work: the poll handler is a pure read (no `bumpPageRequest`) and runs `getPageStatusById`, which skips the `result` + `crawled_pages` columns until the job is terminal. | In-flight reads still hit Postgres on every poll — one read per concurrent active watcher. Multiplier is concurrent-watcher count. Poll cadence is `ui.POLL_INTERVAL_MS` (5 s), chosen so progress still feels live while dropping in-flight read pressure ~3× vs. the old 1.5 s. | Open follow-up: short-TTL (~1 s) Redis cache on in-flight status if concurrent-watcher count per crawl ever becomes a DB-load concern. Collapses N watchers of the same in-flight crawl to ~1 DB read per second. |
| **Monitor cron throughput** | 200 pages per invocation, sequential with 400 ms same-host delays, daily (Vercel Hobby-plan ceiling). Also force-fails stuck jobs past `STUCK_JOB_AFTER_MS` = 15 min at the head of each run. | At ~1 M monitored URLs we can't check them all in a day, let alone in one 300 s invocation. | Tighten the schedule to hourly once on Pro plan, move to a sharded cron (multiple invocations per day, each handling a URL-hash range), or enqueue signature checks onto the queue (above) so they fan out across workers. |
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
3. ~~**Anthropic retry wrapper**~~ — *shipped.* Turned out to be a 3-line config change, not a custom wrapper: `@anthropic-ai/sdk` already retries 408 / 429 / 5xx with exponential backoff and `retry-after` honour built in. We just bumped `maxRetries` from its default of 2 up to 5 and added a 60 s per-call timeout (see `lib/config.ts` → `llm.MAX_RETRIES` / `llm.CALL_TIMEOUT_MS`).
4. ~~**Edge-cache terminal `/p/[id]` responses**~~ — *shipped.* Terminal responses carry `Cache-Control: public, s-maxage=86400, stale-while-revalidate=604800` (1 day fresh, 7 days SWR); `updateJob` revalidates the single `/api/p/{pageId}` path for the touched page on a terminal-result write, so monitor re-crawls invalidate the CDN without waiting for TTL. The long TTL is a safety net — freshness is maintained by the worker-driven invalidation, not the expiry.
5. **Puppeteer pool or Browserless offload** — depends on whether SPA-heavy sites are a meaningful fraction of traffic. Revisit once we have data. *~1–2 days if we do it.*
6. **Sharded monitor cron** — only needed past ~100 K monitored URLs. Revisit. *~1 day.*
7. **Async zip download (QStash + Blob + email)** — only needed once typical histories exceed ~100 entries or `DOWNLOAD_MAX_ENTRIES` grows past 500. Reuses the QStash worker pattern we already run for crawls; adds Vercel Blob (public or private with signed URLs) for storage and a transactional email provider (Resend via the Vercel Marketplace integration is the path of least resistance — one-click, env var injected, 3 k emails/month free tier). *~½ day for the worker + email, plus DNS setup for a verified sender domain.*

Each step is independently shippable, none depends on a later one.

---

## 4. Integration gotchas (lessons from shipping phase-2)

Three real issues surfaced while wiring Upstash + QStash into Vercel
production. Each one was low-value in isolation but the combination
caused a stuck job that looked completely silent — POST returned 201,
no errors in logs, no messages in the QStash console. Worth writing
down so a future integration against the same stack doesn't rediscover
them.

- **`debugLog` was no-op in production.** The original contract was
  "quiet in prod to avoid noise". It meant a failed `qstash.publishJSON`
  threw cleanly into a `catch { debugLog(...) }` that produced nothing
  visible. Fix: emit `Error` payloads at error level regardless of env;
  keep string / object payloads dev-only (see `lib/log.ts`). Operational
  errors should never be gated on `NODE_ENV`.

- **`QSTASH_URL` is region-specific.** The `@upstash/qstash` `Client`
  defaults its `baseUrl` to `https://qstash.upstash.io` (eu-central-1).
  Accounts hosted elsewhere (us-east-1, ap-southeast-1, etc.) return 404
  from that endpoint — but the SDK version we're on doesn't turn that
  into an exception, so publishes "succeed" and drop on the floor.
  Fix: always pass `baseUrl: process.env.QSTASH_URL` through the
  constructor, and log a boot-time warning when `QSTASH_TOKEN` is set
  without its sibling URL (see `lib/upstash/jobQueue.ts`). The Upstash Vercel
  integration ships both env vars; the trap is only hitting us when
  one is missing or forgotten.

- **`VERCEL_URL` is gated by Deployment Protection.** Every deployment
  gets a unique hostname (e.g. `llm-text-generator-giaolx9n2-aesgraph.vercel.app`)
  and those are behind Vercel Auth out of the box. QStash callbacks
  landed on the 401 login page. The **production alias**
  (`llm-text-generator.vercel.app`, exposed as `VERCEL_PROJECT_PRODUCTION_URL`)
  is publicly routable. Fix: prefer that when resolving the worker URL
  (see `lib/upstash/jobQueue.ts` `resolveWorkerUrl`). Preview deploys still need
  either Protection disabled or a bypass token to receive callbacks.

Common thread across all three: failures were silent. Each fix includes
observable logging so the next silent failure isn't silent.

---

## 5. What this costs in complexity

Today's repo is a single Next.js app + one Postgres. Phase 2 adds:

- Upstash Redis — already added. Provisioned via the Vercel Marketplace integration, which auto-injects the env vars into Production + Preview.
- Upstash QStash — already added. Same Vercel integration; env vars (`QSTASH_TOKEN`, `QSTASH_CURRENT_SIGNING_KEY`, `QSTASH_NEXT_SIGNING_KEY`) injected automatically.
- Optional: Browserless — one env var if we offload SPA rendering.

No new languages, no new services beyond managed SaaS. The crawler
logic itself — `pipeline.ts` and everything in `/lib/crawler` — stays
identical. Phase 2 is a migration of *where work executes*, not *what
the work does*.
