# Scaling — Phase 2 Plan

What today's architecture looks like, where it breaks first, and how
to migrate each piece. Written so a reviewer can see we understand the
ceiling of the current design without having already hit it.

---

## 1. What Vercel Fluid Compute gives us today

Fluid Compute is Vercel's current serverless runtime. The pieces that
shape our design:

- **Warm instance reuse.** A single Node process serves many requests
  back-to-back inside one region. Module-level state (in-memory `Map`
  instances, cached Supabase clients, token-bucket records) survives
  across invocations on the same instance.
- **`waitUntil`.** Continues async work after the HTTP response has
  been sent. We use it to dispatch `runCrawlPipeline` in the
  background from `POST /api/p` and `GET /api/monitor`.
- **Default `maxDuration: 300s`.** The two long-running routes are
  configured to this in `vercel.json`. Our crawl budget is
  `PIPELINE_BUDGET_MS: 270_000` — the remaining 30s is headroom for
  `updateJob` to write a clean `failed` state if the pipeline times out.
- **Concurrency within an instance.** A single Fluid instance handles
  many concurrent requests. That's why our in-memory rate limiter is
  effective for any single user hitting us in quick succession — they
  keep landing on the same instance.

It's cheap, it's simple, and it has a real ceiling.

---

## 2. Where we hit walls

In approximate order of which gives first as usage grows:

| Component | Current | What breaks at scale | Fix |
|---|---|---|---|
| **Rate limiter** (`lib/rateLimit.ts`) | **Shipped.** Upstash Redis (`@upstash/ratelimit`) when `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN` are set; in-memory fallback for local dev. Two buckets per principal, both on Upstash: a loose **SUBMIT** floor (60/hr anon, 300/hr auth) charged on every POST to bound abuse of the cheap path, and a tight **NEW_CRAWL** quota (3/hr anon, 10/hr auth) charged only when a submission actually dispatches a fresh crawl — so cache-hit and in-flight-attach paths don't erode the Anthropic/Puppeteer budget guard. Denials surface with `reason: submit_flood` or `reason: new_crawl_quota` plus `retryAfterSec` so the UI renders an accurate "try again in N minutes" message. | Production is covered. Local dev still uses per-instance state — fine, since the fallback is only reached without the env vars. | Open follow-up: enable Upstash `analytics` on both `Ratelimit` instances so denial volume per bucket is observable in a dashboard. |
| **Crawl dispatch** (`lib/jobQueue.ts`) | **Shipped + verified in production.** QStash (at-least-once, signed webhooks) when `QSTASH_TOKEN` is set; `waitUntil(runCrawlPipeline(...))` fallback otherwise. Worker lives at `/api/worker/crawl`, verified via `verifySignatureAppRouter`. Callback target is the production alias (`VERCEL_PROJECT_PRODUCTION_URL`), not the Deployment-Protection-gated per-deployment URL. | Production runs the pipeline synchronously inside the QStash-signed worker so a mid-pipeline failure is a real retry, not a stuck row. Local dev keeps the in-process path so `npm run dev` needs no publicly reachable callback. | Open follow-up: finer-grained step functions (Inngest-style) would let a partial crawl resume after the pipeline aborts, instead of restarting from scratch on retry. Not worth it at current volume. |
| **Anthropic API rate limits** | **Shipped.** `getClient()` in `lib/crawler/llmEnrich.ts` passes `maxRetries: llm.MAX_RETRIES` (5) and `timeout: llm.CALL_TIMEOUT_MS` (60 s) to the SDK, which already retries 408 / 429 / 5xx with exponential backoff and honours `retry-after` / `x-should-retry` response headers. | A bursty minute no longer produces silent quality degradation — calls wait through the backoff window instead of falling through to the deterministic defaults. The 5-retry budget gives ~30 s of total backoff per call, well inside the pipeline budget. | Open follow-up: when the Upstash integration supports concurrency controls (QStash Queues w/ `parallelism`), add a producer-side cap as defence-in-depth. For now the Anthropic tier is the sole concurrency ceiling — plan to upgrade tiers before we hit it. |
| **Puppeteer launches** | Fresh Chromium per crawl that needs SPA rendering. 2–5 s cold-start, ~500 MB memory. `SpaBrowser.close()` in `finally`. | Multiple concurrent SPA crawls on one instance OOM before they finish. The ~500 MB per browser is the hard lower bound. | Either (a) share one `SpaBrowser` across concurrent crawls with a per-page pool, or (b) offload rendering to Browserless.io / Playwright Cloud and drop the dependency. Option (b) scales further; (a) is simpler. |
| **Supabase connection pool** | One service-role client cached per Fluid instance (`lib/store.ts:12`). PgBouncer fronts the DB on port 6543. | At many concurrent cold-start instances, PgBouncer's connection cap (varies by Supabase plan) becomes the bottleneck. Currently not a problem because instance reuse keeps the open-client count low. | Use Supabase's transaction-mode pooler endpoint — short-lived connections per query instead of one per client. Or move hot reads (`getPageByUrl`) to a read-through cache. |
| **`/api/p/[id]` response caching** | **Shipped.** Terminal statuses respond with `Cache-Control: public, s-maxage=86400, stale-while-revalidate=604800` (1 day fresh, 7 days SWR); in-flight polls stay `no-store` so progress remains live. Freshness is driven by the worker, not the TTL: `updateJob` calls `revalidatePath('/api/p/:id')` for every sibling job id on a terminal-result write, so monitor re-crawls invalidate historical job ids immediately. The long TTL is the safety net (rare `revalidatePath` drops, deploys with schema changes, direct SQL writes). | In-flight polls still hit Postgres every 1.5 s — one read per concurrent active job. Multiplier is concurrent-user count, not total-URL count, so far below Postgres's ceiling at any realistic volume. | Open follow-up: short-TTL (~1 s) Redis cache on in-flight status if concurrent-job count ever becomes a DB-load concern. Not relevant at current volume. |
| **Monitor cron throughput** | 200 pages per invocation, sequential with 400 ms same-host delays, daily (Vercel Hobby-plan ceiling). Also force-fails stuck jobs past `STUCK_JOB_AFTER_MS` = 15 min at the head of each run. | At ~1 M monitored URLs we can't check them all in a day, let alone in one 300 s invocation. | Tighten the schedule to hourly once on Pro plan, move to a sharded cron (multiple invocations per day, each handling a URL-hash range), or enqueue signature checks onto the queue (above) so they fan out across workers. |

### What *doesn't* need to change

- **Supabase Postgres as primary store.** Scales fine with the current indexes for another ~2 orders of magnitude of rows.
- **Globally-shared `pages` cache.** This is a *strength* at scale — one `llms.txt` per URL regardless of demand. Popular URLs become hotter cache keys, not more crawls.
- **RLS policies + service-role pattern.** No change.
- **Supabase Auth, cookie-based sessions, middleware refresh.** Scales with Supabase itself.
- **Deterministic pipeline structure.** Every transformation past the LLM calls is pure-function; trivial to move behind a queue unchanged.

---

## 3. Migration sequence

Ordered by value-to-effort ratio:

1. ~~**Redis-backed rate limiter**~~ — *shipped.* One-file swap, same interface; in-memory path kept as a no-env-vars fallback for `npm run dev`.
2. ~~**Durable queue for crawl execution**~~ — *shipped* via QStash (`lib/jobQueue.ts` + `app/api/worker/crawl/route.ts`). Worker runs the pipeline synchronously so QStash's retry-on-non-2xx is real durability. Open follow-up: step-function-style checkpoints (Inngest) to resume partial crawls instead of restarting from scratch.
3. ~~**Anthropic retry wrapper**~~ — *shipped.* Turned out to be a 3-line config change, not a custom wrapper: `@anthropic-ai/sdk` already retries 408 / 429 / 5xx with exponential backoff and `retry-after` honour built in. We just bumped `maxRetries` from its default of 2 up to 5 and added a 60 s per-call timeout (see `lib/config.ts` → `llm.MAX_RETRIES` / `llm.CALL_TIMEOUT_MS`).
4. ~~**Edge-cache terminal `/p/[id]` responses**~~ — *shipped.* Terminal responses carry `Cache-Control: public, s-maxage=86400, stale-while-revalidate=604800` (1 day fresh, 7 days SWR); `updateJob` revalidates every sibling job id's path on a terminal-result write, so monitor re-crawls invalidate the CDN without waiting for TTL. The long TTL is a safety net — freshness is maintained by the worker-driven invalidation, not the expiry.
5. **Puppeteer pool or Browserless offload** — depends on whether SPA-heavy sites are a meaningful fraction of traffic. Revisit once we have data. *~1–2 days if we do it.*
6. **Sharded monitor cron** — only needed past ~100 K monitored URLs. Revisit. *~1 day.*

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
  without its sibling URL (see `lib/jobQueue.ts`). The Upstash Vercel
  integration ships both env vars; the trap is only hitting us when
  one is missing or forgotten.

- **`VERCEL_URL` is gated by Deployment Protection.** Every deployment
  gets a unique hostname (e.g. `llm-text-generator-giaolx9n2-aesgraph.vercel.app`)
  and those are behind Vercel Auth out of the box. QStash callbacks
  landed on the 401 login page. The **production alias**
  (`llm-text-generator.vercel.app`, exposed as `VERCEL_PROJECT_PRODUCTION_URL`)
  is publicly routable. Fix: prefer that when resolving the worker URL
  (see `lib/jobQueue.ts` `resolveWorkerUrl`). Preview deploys still need
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
