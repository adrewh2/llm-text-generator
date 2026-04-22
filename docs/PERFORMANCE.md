# Performance

How much traffic this app can theoretically serve, and where the real
ceilings live. The important framing this document gets right: **there
isn't one throughput number, there are three.** A reviewer asking
"requests per second" is usually asking about something different than
a reviewer asking "crawls per second".

---

## 1. TL;DR — three throughput metrics, not one

Every `POST /api/p` takes one of three paths:

- **Cache hit** — URL was crawled within the last 24 h. Return the existing page UUID.
- **In-flight attach** — an active crawl for this URL already exists. Return its page UUID.
- **New crawl** — schedule a fresh pipeline run via QStash.

These have wildly different resource costs, so "how many can we serve" has three answers:

| Metric | What it means | Capped by |
|---|---|---|
| **Total `POST /api/p` RPS** | Any submission, including cache hits. The user-visible throughput. | Rate-limiter Redis (2–3 commands per cache-hit POST, 4–6 on a new-crawl POST — two buckets, see §2) + one indexed Postgres read |
| **Cache-hit RPS** | Repeat submissions of URLs already crawled (24 h TTL). No LLM, no network out. | Same as above — dominated by Postgres read latency |
| **New-crawl RPS** | Cache-miss submissions that actually run the pipeline. LLM-gated. | Anthropic TPM / RPM |

At any meaningful traffic, the cache-hit rate is the lever that matters most. If 90 % of `POST /api/p`s are repeats of existing URLs, the Anthropic ceiling only governs the remaining 10 %.

### Tier-by-tier ceilings

Order-of-magnitude only. Vendor limits change and prompt costs drift — see each provider's current pricing for real numbers:

| Configuration | New-crawl ceiling | Binding constraint |
|---|---|---|
| **Free everything** | a couple per minute sustained | QStash's daily message cap is the tightest floor |
| **Vercel Pro + Anthropic Tier 1** | tens per minute | Anthropic tier RPM |
| **Vercel Pro + Anthropic Tier 3** | hundreds per minute | Anthropic tier RPM |
| **Enterprise** (see §6) | thousands per minute | Anthropic TPM, linear in negotiated quota |

Total `POST /api/p` RPS (cache hits included) is an order of magnitude higher than the new-crawl ceiling at every tier, because cache hits skip the expensive work entirely.

---

## 2. What one crawl actually spends

Per cache-miss crawl (pipeline runs end-to-end), order-of-magnitude accounting. Exact numbers drift with every prompt tweak and with crawler caps in `lib/config.ts`; the shape of the ceiling is what matters:

| Resource | Typical usage |
|---|---|
| HTTP requests *out* (to target sites) | dozens (robots + sitemap + page fetches + external-ref fetches + markdown probes) |
| Anthropic Haiku calls | a handful per crawl (one for URL ranking, one per enrichment batch, optional external-ref ranker, site-name + preamble) |
| Anthropic tokens | ~20 K total per crawl, input-dominant |
| Supabase writes | under a dozen (status transitions + debounced progress + terminal write) |
| Supabase reads | a handful (cache lookup + the client's poll loop) |
| Upstash Redis commands | a few (bucket checks) |
| QStash messages | 1 |
| Vercel function time | ~30–60 s wall clock, much less active CPU (mostly I/O-wait) |
| Vercel memory | ~50–100 MB non-SPA, ~500 MB when Puppeteer fires |

Per cache-hit request (fast path):

| Resource | Typical usage |
|---|---|
| Supabase reads | 1 (existing `pages.result` lookup by primary key) |
| Supabase writes | 1–2 (`bumpPageRequest`, plus `upsertUserRequest` if signed-in) |
| Upstash Redis commands | 2–3 (SUBMIT bucket check only — cache-hit path skips the NEW_CRAWL bucket) |
| Anthropic calls | **0** |
| QStash messages | **0** |
| Vercel function time | <100 ms |

The contrast is the point — cache hits are ~1000× cheaper than new crawls, and the application is designed to make them common (globally-shared `pages` row, 24 h TTL, signature-based monitor re-crawl).

---

## 3. Where the real ceilings live

### Free tier (the ordering a demo hits)

1. **QStash's daily message cap** is the tightest constraint — every new crawl is one message. A demo at low traffic is fine; sustained use hits this first.
2. **Anthropic Tier 1 RPM** is the next ceiling. A handful of LLM calls per crawl × the tier's RPM gives the per-minute new-crawl budget. The SDK's built-in retry absorbs brief overshoots; if retries exhaust, a deterministic fallback keeps the crawl completing (details in [`SCALING.md §2`](./SCALING.md#2-where-we-hit-walls)).
3. **Upstash Redis command count** on the free tier is fine at demo traffic — each POST is a handful of commands and the global ceiling is well above any single-user traffic pattern.
4. **Vercel Hobby + Supabase free** caps are irrelevant at demo traffic.

### Paid tier (Vercel Pro + Anthropic Tier 3 + Upstash PAYG + Supabase Pro)

1. **Anthropic tier RPM / TPM** is the binding constraint above free tier for any realistic cache-miss share.
2. **Puppeteer memory on SPA-heavy traffic.** A Chromium render consumes on the order of half a gig. Each Fluid instance hosts one or two concurrent SPA crawls; scales horizontally past that.
3. **Supabase Pro connection-pool ceiling** is far above our actual usage because we cache one service-role client per Fluid instance.
4. **QStash PAYG** has no practical cap at single-digit RPS.

### Enterprise

See §6.

---

## 4. Supabase — growth projections and bottlenecks

Postgres is the only stateful component in the system (Upstash and QStash are ephemeral by design), so it's the one worth modeling explicitly over time.

### Row shape (for intuition)

| Table | Dominant field | Rough row size |
|---|---|---|
| `pages` | `result` (markdown) + `crawled_pages` (scored page JSONB, ~25 entries) | order of 10 KB |
| `jobs` | `progress` JSONB + short status/error strings | under 1 KB |
| `user_requests` | two UUIDs + timestamp | a few hundred bytes |

### Growth model

Storage scales with three independent quantities: unique URLs (one `pages` row each), total crawl attempts per URL over time (one `jobs` row each — dominated by monitor-triggered re-crawls), and per-user saved URL count (one `user_requests` row each). The `pages` table dominates on bytes (JSONB `crawled_pages` is by far the heaviest per-row field); `jobs` dominates on row count but each row is tiny.

For a rough ceiling: at order-of-magnitude **new URLs per day × 5 years × ~monthly re-crawl cadence**, each step up in traffic adds roughly an order of magnitude to total DB size. Past the "real product" regime — ~1K unique new URLs/day sustained — `jobs` becomes row-count-heavy enough to warrant a cleanup cron (see §4 bottlenecks below). A personal demo never gets close to any of the platform ceilings.

### Where Supabase gives first

Roughly in the order things break as traffic scales up:

1. **DB size.** The `pages.crawled_pages` JSONB column dominates storage, and without a `jobs`-cleanup cron, monitor re-crawls keep stacking rows. First mitigation is a cleanup cron that drops older terminal `jobs` rows once a newer terminal exists for the same URL; second is trimming `crawled_pages` (e.g. drop `bodyExcerpt` once enrichment has consumed it).
2. **Connection pool pressure.** Supabase's PgBouncer handles many concurrent connections out of the box; because we cache one service-role client per Fluid instance, the open-connection count scales with instance count, not request count. Only becomes a bottleneck at very high concurrent-instance counts — use Supabase's transaction-mode pooler when that happens.
3. **Read-heavy traffic on `/p/[id]` polling.** Terminal responses are already edge-cached and invalidated on re-crawl, so repeat polls of finished jobs don't reach Postgres. In-flight polls still read the DB every poll interval; bounded by concurrent-user count, not total row count, so not a near-term worry.

### What doesn't get worse with size

Primary-key lookups on `pages` and `jobs`, dashboard history pagination (indexed by user + created_at), and RLS enforcement (simple equality checks) all stay constant-time regardless of total row count.

### What would actually break before Supabase does

In practice, Anthropic's per-tier TPM runs out long before the DB does. The DB bottleneck is an order-of-magnitude problem; Anthropic is the two-orders problem.

---

## 5. What's *not* the bottleneck

- **Vercel Fluid Compute concurrency.** The runtime packs many concurrent I/O-bound requests into each instance and auto-scales instances horizontally. No configuration required. Our 30–60 s I/O-bound crawl is the textbook case Fluid is optimized for.
- **QStash delivery throughput.** Push-based, parallel fan-out. 100 concurrent messages → 100 concurrent worker POSTs.
- **The deterministic crawling itself.** If LLM enrichment were disabled entirely, the pipeline's mechanical parts (robots, sitemap, HTTP fetches, cheerio extraction, scoring, assembly) could run at hundreds per second per Fluid instance — the constraint is network bandwidth and target-site politeness, not our code. The output would be spec-valid but quality-degraded (no LLM URL ranking, no LLM descriptions, path-inferred sections, no preamble).
- **Globally-shared `pages` cache.** This is a *strength* at scale: popular URLs become hotter cache keys, not more crawls. No sharding, no dedup pass required.

---

## 6. Maximum performance at enterprise — what the design can actually do

Assuming every service is on a tier where it's no longer a meaningful constraint (Anthropic Enterprise with negotiated TPM, Vercel Enterprise for concurrency, Supabase Team/Enterprise for DB size, Upstash paid plans, Puppeteer offloaded to Browserless), the binding constraints shift to the shape of the design rather than the free-tier ceiling of any one dependency:

- **Total RPS** is bounded by the rate-limiter's Redis round-trip and Vercel routing; a CDN-cached rate-limit layer would lift it further. In practice four figures of RPS is achievable.
- **Cache-hit RPS** is bounded by one indexed Postgres read per hit — scales horizontally across regions, and edge-caching the terminal responses pushes the effective ceiling an order of magnitude higher.
- **New-crawl RPS (LLM-enriched)** scales linearly with negotiated Anthropic TPM. At token budgets per crawl measured in tens of thousands, this is the constraint that decides how aggressively any paid tier needs to be upgraded. Plan as: `TPM quota / tokens-per-crawl / 60 = sustained new crawls per second`.
- **New-crawl RPS (deterministic fallback)** is much higher — all LLM calls hit their fallbacks, output is spec-valid but un-enriched, the ceiling becomes target-site politeness rather than our own code.
- **Database growth sustainability** depends on whether a `jobs`-cleanup cron is in place. Without one, monitor re-crawls accumulate rows faster than `pages` itself.

The honest high-water mark for a full-quality enterprise deployment: new crawls in the thousands per minute sustained, cache-hit traffic an order of magnitude above that. Substantially beyond any take-home demo load.

### What caps us even at enterprise tier

Even with unlimited budget:

1. **Anthropic TPM** remains the core ceiling for LLM-enriched output. Each crawl's ~20 K tokens is the lever to cut if we want more throughput per dollar — smaller prompts, fewer enrich batches, or cheaper-model-per-step routing.
2. **Puppeteer memory for SPA-heavy workloads** — only if we skip the Browserless offload.
3. **Target-site politeness** is an inherent ceiling; crawling any single domain faster than ~5 req/s is rude regardless of our capacity.

---

## 7. Where to look at runtime

See [`OBSERVABILITY.md §5`](./OBSERVABILITY.md#5-where-to-look-when-something-breaks) for the list of dashboards to watch (Sentry, Vercel logs, Supabase, Upstash, Anthropic) and what each one surfaces.

---

## 8. Scaling the next 10×

The concrete migration sequence — which bottleneck to fix first, how much each fix costs, what's already shipped — lives in [`SCALING.md §3`](./SCALING.md#3-migration-sequence). The short version: upgrading the Anthropic tier is the single biggest lever; everything else (jobs-table cleanup cron, Puppeteer offload, sharded monitor cron, async zip download) is independently shippable once it's actually needed.
