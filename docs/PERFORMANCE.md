# Performance

How much traffic this app can theoretically serve, and where the real
ceilings live. The important framing this document gets right: **there
isn't one throughput number, there are three.** A reviewer asking
"requests per second" is usually asking about something different than
a reviewer asking "crawls per second".

---

## 1. TL;DR — three throughput metrics, not one

Every `POST /api/p` takes one of three paths:

- **Cache hit** — URL was crawled within the last 24 h. Return the existing job id.
- **In-flight attach** — an active crawl for this URL already exists. Return its job id.
- **New crawl** — schedule a fresh pipeline run via QStash.

These have wildly different resource costs, so "how many can we serve" has three answers:

| Metric | What it means | Capped by |
|---|---|---|
| **Total `POST /api/p` RPS** | Any submission, including cache hits. The user-visible throughput. | Rate-limiter Redis (2-3 commands per POST) + one indexed Postgres read |
| **Cache-hit RPS** | Repeat submissions of URLs already crawled (24 h TTL). No LLM, no network out. | Same as above — dominated by Postgres read latency |
| **New-crawl RPS** | Cache-miss submissions that actually run the pipeline. LLM-gated. | Anthropic TPM / RPM |

At any meaningful traffic, the cache-hit rate is the lever that matters most. If 90 % of `POST /api/p`s are repeats of existing URLs, the Anthropic ceiling only governs the remaining 10 %.

### Tier-by-tier ceilings

| Configuration | Total RPS | New-crawl RPS | Binding constraint on new crawls |
|---|---|---|---|
| **Free everything** | ~60–70 /sec* | ~0.03 /sec (~2/min) sustained over a day | QStash free: 500 msgs/day is the tightest floor |
| **Vercel Pro + Anthropic Tier 1 + Upstash PAYG** | ~200 /sec | **~0.2 /sec (~12/min)** | Anthropic Tier 1: 60 RPM / ~100 K TPM |
| **Vercel Pro + Anthropic Tier 3 + Upstash PAYG** | ~500 /sec | **~10 /sec (~600/min)** | Anthropic Tier 3: 3 K RPM |
| **Enterprise across the board** (see §6) | >**10 K /sec** | **~40 /sec (~2 400/min)** at 50 M TPM; scales with quota | Anthropic TPM; ~21 K tokens per crawl |

*Free-tier Total RPS floor is Upstash Redis: 500 K commands/month ÷ (30 days × 86 400 sec) × (1 request / 2 commands) ≈ 97 RPS sustained. In bursts, much higher.

---

## 2. What one crawl actually spends

Per cache-miss crawl (pipeline runs end-to-end), rough accounting:

| Resource | Typical usage |
|---|---|
| HTTP requests *out* (to target sites) | ~35 (1 robots + 1–3 sitemap + 25 page fetches + 0–8 external-ref fetches + markdown probes) |
| Anthropic Haiku calls | 3–5 (`rankCandidateUrls`, `enrichBatch` × ⌈pages/20⌉, `rankExternalReferences`, `llmSiteName`, `generateSitePreamble`) |
| Anthropic tokens | ~18 K input + ~3 K output ≈ **21 K total** |
| Supabase writes | ~10 (status transitions + progress updates + final `pages` write) |
| Supabase reads | ~5 (cache lookup, polling by client) |
| Upstash Redis commands | 2–3 (rate-limit bucket check on the initial POST) |
| QStash messages | 1 |
| Vercel function time | ~30–60 s wall clock, much less active CPU (mostly I/O-wait) |
| Vercel memory | ~50–100 MB non-SPA, ~500 MB when Puppeteer fires |

Per cache-hit request (fast path):

| Resource | Typical usage |
|---|---|
| Supabase reads | 1 (existing `pages.result` lookup by primary key) |
| Supabase writes | 1 (`bumpPageRequest` + `upsertUserRequest` if signed-in) |
| Upstash Redis commands | 2–3 (rate limiter) |
| Anthropic calls | **0** |
| QStash messages | **0** |
| Vercel function time | <100 ms |

The contrast is the point — cache hits are ~1000× cheaper than new crawls, and the application is designed to make them common (globally-shared `pages` row, 24 h TTL, signature-based monitor re-crawl).

---

## 3. Where the real ceilings live

### Free tier (the ordering a demo hits)

1. **QStash free: 500 messages/day.** Every new crawl = 1 message. The day cap is the tightest constraint by far — ~20/hour sustained if perfectly spaced.
2. **Anthropic Haiku Tier 1: ~60 RPM / ~50 K TPM.** 4 LLM calls per crawl → ~15 crawls/min before 429s. The SDK's default `maxRetries: 2` (with exponential backoff and `Retry-After` honoured) absorbs brief overshoot; if retries exhaust, each enrichment step has a deterministic fallback so the crawl still completes.
3. **Upstash Redis free: 500 K commands/month.** Every `POST /api/p` uses 2–3 commands for the rate-limit bucket. ~70 POSTs/sec sustained before overage — **not** a real constraint at free-tier traffic.
4. **Vercel Hobby:** soft invocation cap; not close at demo traffic.
5. **Supabase free: 500 MB DB, 60-connection pool.** Our workload uses ~1 connection per Fluid instance; not close.

### Paid tier (Vercel Pro, Anthropic Tier 3, Upstash PAYG, Supabase Pro)

1. **Anthropic Haiku Tier 3: 3 K RPM / ~4 M TPM.** 4–5 calls per crawl → **~600 new crawls/min (~10/sec).** This is the binding constraint above free tier for any realistic share of cache-miss traffic.
2. **Puppeteer memory on SPA-heavy traffic.** ~500 MB per concurrent render on a default 1 GB instance; handles 1–2 concurrent SPA crawls per instance, scales horizontally.
3. **Supabase Pro: ~200 concurrent connections, 8 GB DB included.** Our client is cached per Fluid instance, so concurrent connections scale with instance count, not request count.
4. **QStash PAYG:** no practical cap at single-digit RPS.

### Enterprise

See §6.

---

## 4. Supabase — growth projections and bottlenecks

Postgres is the only stateful component in the system (Upstash and QStash are ephemeral by design), so it's the one worth modeling explicitly over time.

### Row sizes

| Table | Typical row | Dominant field |
|---|---|---|
| `pages` | ~8–15 KB | `result` (TEXT, a few KB of markdown) + `crawled_pages` (JSONB, ~500 bytes × 25 pages ≈ 12 KB) |
| `jobs` | ~500 B | `progress` JSONB + short status/error strings |
| `user_requests` | ~100 B | two UUIDs + timestamp |

### Growth model (5 years, three scenarios)

Assumes the monitor cron re-crawls each page ~12 times/year on average (one re-crawl per signature change).

| Scenario | New unique URLs/day | 5-yr `pages` rows | 5-yr `jobs` rows | 5-yr `user_requests` rows | Total DB size |
|---|---|---|---|---|---|
| **Small** (personal demo) | 10 | 18 K | 1.1 M | 5 K × 50 pages = 250 K | ~800 MB |
| **Medium** (side project, traction) | 100 | 180 K | 11 M | 10 K × 100 = 1 M | ~8 GB |
| **Large** (real product) | 1 000 | 1.8 M | 110 M | 100 K × 200 = 20 M | ~80 GB |
| **Enterprise** (commercial) | 10 000 | 18 M | 1.1 B | 1 M × 500 = 500 M | ~800 GB |

The `pages` table dominates storage (the JSONB `crawled_pages` column is by far the heaviest per-row field). `jobs` is row-count-heavy but each row is tiny.

### Where Supabase gives first

In order of what breaks as the numbers above grow:

1. **Supabase Pro DB size cap.** 8 GB included; beyond that $0.125/GB. The **Medium** scenario above (8 GB) is at the edge. The primary mitigation is dropping old `jobs` rows — they accumulate but aren't needed once a page has a newer terminal job. A cleanup cron that deletes jobs older than 30 days where a more-recent terminal job exists for the same `page_url` keeps `jobs` capped to roughly the live set.
2. **JSONB storage pressure on `pages.crawled_pages`.** At ~12 KB per row × 1 M+ pages, this is the dominant cost. Mitigations: (a) drop `bodyExcerpt` from the stored JSONB once the LLM enrichment has consumed it, (b) move `crawled_pages` to a separate table with cold-storage partitioning by date, (c) switch to Supabase Storage for historical snapshots.
3. **Connection pool saturation.** Supabase Pro's default PgBouncer pool is ~200 concurrent connections. Our server-side code caches one client per Fluid instance, so at the "Large" scenario with ~100 concurrent instances, we're at ~50 % pool utilization — plenty of headroom. Only matters past ~500 concurrent instances.
4. **Query performance on the `jobs` table at 100 M+ rows.** The existing index `idx_jobs_page_status_created (page_url, status, created_at DESC)` stays fast because it's used with an equality filter on `page_url`. No full scans. Writes stay fast. Vacuum / autovacuum pressure rises but is managed by Supabase.
5. **Read-heavy traffic on `/p/[id]` polling.** Terminal responses are edge-cached on Vercel's CDN (`s-maxage=3600, stale-while-revalidate=86400`) with targeted revalidation via `revalidatePath` on every terminal-result write — see `app/api/p/[id]/route.ts` and `lib/store.ts`. Repeat polls for finished jobs no longer touch Postgres. In-flight polls still read the DB every 1.5 s (bounded by concurrent-user count, not total-URL count).

### What doesn't get worse with size

- **`pages` lookup by URL** — primary key, constant-time regardless of row count.
- **`jobs` lookup by id** — primary key, same.
- **Dashboard history pagination** — backed by `idx_user_requests_user_created (user_id, created_at DESC)`, scales with pages viewed, not total table size.
- **RLS enforcement cost** — our policies are simple equality checks; no measurable overhead.

### What would actually break before Supabase does

At "Large" traffic (1 K new URLs/day sustained), Anthropic TPM becomes the binding constraint long before Supabase does. 1 K new URLs/day is ~0.012/sec sustained, well within Tier 3 bounds. The DB bottleneck is an order-of-magnitude problem; Anthropic is the two-orders problem.

---

## 5. What's *not* the bottleneck

- **Vercel Fluid Compute concurrency.** The runtime packs many concurrent I/O-bound requests into each instance and auto-scales instances horizontally. No configuration required. Our 30–60 s I/O-bound crawl is the textbook case Fluid is optimized for.
- **QStash delivery throughput.** Push-based, parallel fan-out. 100 concurrent messages → 100 concurrent worker POSTs.
- **The deterministic crawling itself.** If LLM enrichment were disabled entirely, the pipeline's mechanical parts (robots, sitemap, HTTP fetches, cheerio extraction, scoring, assembly) could run at hundreds per second per Fluid instance — the constraint is network bandwidth and target-site politeness, not our code. The output would be spec-valid but quality-degraded (no LLM URL ranking, no LLM descriptions, path-inferred sections, no preamble).
- **Globally-shared `pages` cache.** This is a *strength* at scale: popular URLs become hotter cache keys, not more crawls. No sharding, no dedup pass required.

---

## 6. Maximum performance at enterprise — what the design can actually do

Assuming every service is on a tier where it's no longer a meaningful constraint:

- **Anthropic Enterprise:** negotiated quota — for this estimate assume **50 M TPM** (achievable on a typical enterprise contract for Haiku-class traffic).
- **Vercel Enterprise:** dedicated compute, effectively unbounded concurrent function invocations.
- **Supabase Team/Enterprise:** dedicated cluster, read replicas, configurable connection pool, no DB size cap.
- **Upstash paid plans:** no practical caps.
- **Puppeteer offloaded to Browserless** (removes the per-instance memory ceiling for SPA sites).

Under those conditions, the ceilings shift to:

| Metric | Enterprise ceiling | Notes |
|---|---|---|
| **Total `POST /api/p` RPS** | **>10 000 /sec** | Limited by Vercel routing + the Redis rate-limiter round trip. Could go higher with a CDN-cached rate-limit layer. |
| **Cache-hit RPS** | **~5 000 /sec per-region, linear with region count** | One indexed Postgres read per hit. Edge-cached terminal responses push this to >50 000 /sec trivially. |
| **New-crawl RPS (LLM-enriched)** | **~40 /sec sustained (~2 400/min)** at 50 M TPM | 21 K tokens × 40 = 840 K TPM utilization; headroom for burst. Scales linearly with negotiated TPM. |
| **New-crawl RPS (deterministic fallback)** | **~300 /sec per region** | All LLM calls hit their existing fallbacks; output is spec-valid but un-enriched. Limited by target-site politeness, not our code. |
| **Database growth sustainability** | **~2 years at 10 K new URLs/day** before active archiving is needed | Mitigation (see §4): job-row TTL cleanup + JSONB column trimming. |

**The honest high-water mark for a full-quality enterprise deployment is in the hundreds-of-millions of crawls/year range** — call it ~2 K new crawls/min sustained, with cache-hit traffic of tens of thousands of RPS on top. That's a serious commercial scale; substantially beyond any take-home demo load.

### What caps us even at enterprise tier

Even with unlimited budget:

1. **Anthropic TPM** remains the core ceiling for LLM-enriched output. Each crawl's ~21 K tokens is the lever to cut if we want more throughput per dollar — smaller prompts, fewer enrich batches, or cheaper-model-per-step routing.
2. **Puppeteer memory for SPA-heavy workloads** — only if we skip the Browserless offload.
3. **Target-site politeness** is an inherent ceiling; crawling any single domain faster than ~5 req/s is rude regardless of our capacity.

---

## 7. Observability

- **Upstash dashboard** → QStash events: per-delivery timings, retries, error codes.
- **Upstash dashboard** → Redis usage: command-month counter.
- **Anthropic console** → rate-limit / token-usage graphs.
- **Supabase dashboard** → query-perf, slow-query log, connection-pool graph, storage by table.
- **Vercel logs** — our `[enqueueCrawl] branch=…` line emits on every submission; a spike of `branch=fallback:*` means QStash state has drifted and the queue is quietly not getting used.

---

## 8. If we had to scale 10× (in priority order)

1. **Upgrade Anthropic tier.** Tier 1 → Tier 3 is ~50× RPM; the single biggest lever.
2. ~~**Edge-cache terminal `/p/[id]` responses.**~~ *Shipped.* Terminal polls serve from Vercel's CDN; `updateJob` calls `revalidatePath` for every sibling job id when a terminal result is written, so monitor re-crawls invalidate historical job ids immediately. Postgres reads on the polling path drop to near-zero for completed crawls.
3. **QStash Queues with parallelism cap.** Smooths bursts into Anthropic without retry storms.
4. **Supabase jobs-table cleanup cron** (delete old `jobs` rows where a newer terminal exists). Keeps DB size bounded.
5. **Browserless offload for Puppeteer** if SPA-heavy traffic becomes a meaningful share.

Each is independently shippable; none blocks the others. All are sketched in `docs/SCALING.md` with cost/effort estimates.
