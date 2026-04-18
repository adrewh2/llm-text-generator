# Scaling — Phase 2 Plan

What today's architecture looks like, where it breaks first, and how
to migrate each piece. Written so a reviewer can see we understand the
ceiling of the current design without having already hit it.

---

## 1. What Vercel Fluid Compute gives us today

Fluid Compute is Vercel's current serverless runtime. The pieces that
shape our design:

- **Warm instance reuse.** A single Node process serves many requests
  back-to-back inside one region. Module-level state (`Map`s, cached
  Supabase clients, token-bucket records) survives across invocations
  on the same instance.
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
| **Rate limiter** (`lib/rateLimit.ts`) | **Shipped.** Upstash Redis when `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN` are set; in-memory fallback for local dev otherwise. | Production is covered. Local dev still uses per-instance state — fine, since the fallback is only reached without the env vars. | Open follow-up: enable Upstash `analytics` on the `Ratelimit` instance so denials are observable in a dashboard. |
| **Crawl dispatch** (`waitUntil(runCrawlPipeline)`) | Runs in the request's own Fluid instance. No retry if the instance dies mid-flight. | Instance recycled, runtime crash, or an `updateJob` that fails right as the job flips to terminal — the crawl's progress is lost and the row is stuck non-terminal until the next monitor cron or stuck-job sweeper clears it. No backpressure: 100 concurrent crawls spawn 100 concurrent function instances. | Move to a durable queue — Vercel Queues (native, at-least-once, beta) or Inngest (mature, step functions). The pipeline stays the same; `POST /api/p` and `dispatchRecrawl` become enqueues. `app/api/monitor/route.ts:91` already names `dispatchRecrawl` as "the seam a future queue would replace." |
| **Anthropic API rate limits** | No retry on 429/5xx from Claude; each crawl fires 3–5 calls (`rankCandidateUrls`, `enrichBatch`, `rankExternalReferences`, `llmSiteName`, `generateSitePreamble`) | At high concurrency we'll trip Haiku's per-account requests-per-minute limit. A failed call silently falls back to deterministic defaults, which is correct behaviour but quietly degrades output quality. | Wrap `client.messages.create` in a retry helper with exponential backoff (the SDK has one opt-in). Add a global LLM semaphore (e.g. max 10 concurrent calls per instance) to smooth bursts into the provider. |
| **Puppeteer launches** | Fresh Chromium per crawl that needs SPA rendering. 2–5 s cold-start, ~500 MB memory. `SpaBrowser.close()` in `finally`. | Multiple concurrent SPA crawls on one instance OOM before they finish. The ~500 MB per browser is the hard lower bound. | Either (a) share one `SpaBrowser` across concurrent crawls with a per-page pool, or (b) offload rendering to Browserless.io / Playwright Cloud and drop the dependency. Option (b) scales further; (a) is simpler. |
| **Supabase connection pool** | One service-role client cached per Fluid instance (`lib/store.ts:12`). PgBouncer fronts the DB on port 6543. | At many concurrent cold-start instances, PgBouncer's connection cap (varies by Supabase plan) becomes the bottleneck. Currently not a problem because instance reuse keeps the open-client count low. | Use Supabase's transaction-mode pooler endpoint — short-lived connections per query instead of one per client. Or move hot reads (`getPageByUrl`) to a read-through cache. |
| **`/p/[id]` response is always DB-read** | Every poll hits Postgres. Terminal jobs are identical forever (immutable once written). | At 1 K active result pages polling every 1.5 s, we're doing ~660 reads/sec against Postgres just for status. | For terminal jobs, set `Cache-Control: public, s-maxage=60, stale-while-revalidate=3600` and let Vercel's Edge Cache serve most polls. Client polling already stops at terminal state so the total traffic drop is real. |
| **Monitor cron throughput** | 200 pages per invocation, sequential with 400 ms same-host delays, daily | At ~1 M monitored URLs we can't check them all in a day, let alone in one 300 s invocation. | Move to a sharded cron (multiple invocations per day, each handling a URL-hash range), or enqueue signature checks onto the queue (above) so they fan out across workers. |

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
2. **Durable queue for crawl execution** — biggest correctness win at scale, but the largest refactor. The `dispatchRecrawl` seam in `app/api/monitor/route.ts` is already the shape this wants. `POST /api/p`'s `waitUntil(runCrawlPipeline)` becomes an enqueue. Adds a `/api/worker` handler for the consumer. *~2 days.*
3. **Anthropic retry wrapper** — one helper around `client.messages.create`, applied everywhere. *~half-day.*
4. **Edge-cache terminal `/p/[id]` responses** — headers-only change in `app/api/p/[id]/route.ts`. Forces us to only set the cache headers for terminal statuses, which keeps polling clients correct. *~half-day.*
5. **Puppeteer pool or Browserless offload** — depends on whether SPA-heavy sites are a meaningful fraction of traffic. Revisit once we have data. *~1–2 days if we do it.*
6. **Sharded monitor cron** — only needed past ~100 K monitored URLs. Revisit. *~1 day.*

Each step is independently shippable, none depends on a later one.

---

## 4. What this costs in complexity

Today's repo is a single Next.js app + one Postgres. Phase 2 adds:

- Upstash Redis — already added. Provisioned via the Vercel Marketplace integration, which auto-injects the env vars into Production + Preview.
- Vercel Queues or Inngest — next step. One dependency, one new `/api/worker` handler.
- Optional: Browserless — one env var if we offload SPA rendering.

No new languages, no new services beyond managed SaaS. The crawler
logic itself — `pipeline.ts` and everything in `/lib/crawler` — stays
identical. Phase 2 is a migration of *where work executes*, not *what
the work does*.
