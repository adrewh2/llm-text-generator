# Performance

How much traffic this app can theoretically serve, ordered by what
actually caps us. The short answer: the code itself is not the
bottleneck in any useful sense — **external service tiers are.** This
document makes that honest.

---

## 1. TL;DR — crawl throughput by tier

One "crawl" = one `POST /api/p` → 1 QStash message → 1 worker invocation
→ a result row in Supabase. Roughly 30–60 seconds of wall-clock; much
less active CPU.

| Configuration | Ceiling | Set by |
|---|---|---|
| **Free everything** (Hobby Vercel + free Anthropic + free Upstash) | **~0.35 crawls/sec sustained**, tighter over a full day | QStash free: 500 msgs/day |
| **Vercel Pro + Anthropic Tier 1 + Upstash pay-as-you-go** | **~0.2 crawls/sec sustained**, ~12/min | Anthropic Tier 1 RPM |
| **Vercel Pro + Anthropic Tier 3 + Upstash pay-as-you-go** | **~10 crawls/sec sustained**, 600/min | Anthropic Tier 3 RPM |
| **Enterprise across the board (custom Anthropic quota)** | **Limited by TPM, not RPM** — typically 1–2 crawls/sec per 2 M input-TPM, scales with negotiated quota | Anthropic tokens-per-minute |

Cached hits don't count toward any of these — they return in <100 ms
from a Postgres read and only touch the Redis rate limiter.

---

## 2. What one crawl actually spends

Per crawl, rough accounting:

| Resource | Typical usage |
|---|---|
| HTTP requests *out* | ~35 (1 robots + 1–3 sitemap + 25 page fetches + 0–8 external-ref fetches + markdown probes) |
| Anthropic Haiku calls | 3–5 (`rankCandidateUrls`, `enrichBatch` × ⌈pages/20⌉, `rankExternalReferences`, `llmSiteName`, `generateSitePreamble`) |
| Anthropic tokens | ~18 K input + ~3 K output ≈ **21 K total** |
| Supabase writes | ~10 (status transitions + progress updates + final write) |
| Supabase reads | ~5 (cache lookup, job lookup during polling by client) |
| Upstash Redis commands | 2–3 (rate-limit bucket check on the initial POST) |
| QStash messages | 1 |
| Vercel function time | ~30–60 s wall clock, much less active CPU (mostly I/O-wait) |
| Vercel memory | ~50–100 MB non-SPA, ~500 MB when Puppeteer fires |

Cached hits (<24 h old) skip *everything except* the Redis rate-limit
check and one Postgres read. An hour of steady cache-hit traffic
barely registers.

---

## 3. Where the real ceilings live

Ordered by which gives first as traffic grows. **This ordering flips
depending on tier** — at free tier it's the message quotas; at paid
tier it's Anthropic; at enterprise it's Anthropic TPM.

### Free tier (the ordering you'll hit demoing this)

1. **QStash free plan: 500 messages/day.** Each crawl = 1 message. ~20 crawls/hour sustained if perfectly spaced; you'll hit the cap before any other service notices.
2. **Anthropic Haiku free/Tier 1: ~60 requests/minute.** 4 calls/crawl × 12 crawls/min = 48 req/min — right at the edge.
3. **Upstash Redis free: 500 K commands/month.** Rate limiter spends 2–3 commands per submission. Works out to ~70 submissions/second *sustained* before you'd exceed, so not a real constraint.
4. **Vercel Hobby:** soft function-invocation cap; for a demo-scale workload, effectively unlimited.
5. **Supabase free:** 60-connection PgBouncer pool, 500 MB DB. Not close.

### Paid tier (Vercel Pro, Anthropic Tier 3, Upstash pay-as-you-go)

1. **Anthropic Haiku Tier 3: 50 RPS (3000 RPM).** Divide by 4–5 calls per crawl → ~10 crawls/sec sustained. This is the ceiling the app will hit long before anything else notices.
2. **Puppeteer memory for SPA sites.** ~500 MB per concurrent SPA render. A default 1 GB Vercel function instance handles ~1–2 concurrent SPA crawls; others queue or spawn new instances.
3. **Supabase Pro connection pool:** ~200–400 concurrent connections. Our code caches a single client per Fluid instance, so this scales with instance count, not request count. Not an issue at 10 RPS.
4. **QStash pay-as-you-go:** no practical cap at single-digit RPS.

### Enterprise (custom Anthropic quota)

Past ~50 crawls/sec sustained, the bottleneck flips from **requests/minute** to **tokens/minute**. Each crawl uses ~21 K tokens, so:

- 500 K TPM Anthropic quota → ~24 crawls/min (0.4/sec) even if the RPM is unlimited.
- 2 M TPM → ~95 crawls/min (1.6/sec).
- 10 M TPM (enterprise negotiation) → ~475 crawls/min (~8/sec).

At this scale, the levers are: reduce token usage per crawl (smaller prompts, cheaper model, fewer enrich batches), negotiate higher TPM, or route across multiple Anthropic accounts.

Above ~100 crawls/sec, Puppeteer memory and Supabase connection pool also start to matter — but that's a real-product scaling problem, not a take-home one.

---

## 4. What's *not* the bottleneck (despite looking like it might be)

- **Vercel Fluid Compute concurrency.** The runtime packs many concurrent I/O-bound requests into each instance and auto-scales instances horizontally. No configuration involved. Our workload (30–60 s per crawl, mostly waiting on network) is the textbook case it's optimized for.
- **QStash delivery throughput.** Push-based, parallel. If we publish 100 messages simultaneously, QStash fans them out to 100 concurrent POSTs. No queue-side serialization.
- **Postgres at current row counts.** `pages`, `jobs`, `user_requests` indexes are tight; queries return in <10 ms. Scales for another ~2 orders of magnitude without index changes.
- **Globally-shared `pages` cache.** Popular URLs become hotter cache keys, not more crawls. Every repeat submission of the same URL within 24 hours skips the whole pipeline and just bumps `last_requested_at`.

---

## 5. Observability — how to check where we are

- **Upstash dashboard** → QStash events tab: per-delivery timings, retry counts, error codes.
- **Upstash dashboard** → Redis usage: commands/month against the 500 K free limit.
- **Anthropic console** → rate limits / token usage per day.
- **Supabase dashboard** → query perf, slow-query log, connection pool graph.
- **Vercel logs** — our own `[enqueueCrawl] branch=…` line emits on every submission; a sudden spike of `branch=fallback:*` means QStash state has drifted and dispatches are quietly running in-process instead of via the queue.

---

## 6. If we had to scale 10×

In priority order, what to lift:

1. **Upgrade Anthropic tier** (biggest single lever). Tier 1 → Tier 3 is ~50× the RPM for the price of continued usage.
2. **Enable QStash Queues with a parallelism cap** if the Anthropic-retry layer isn't enough — lets us hold messages queued rather than retry-storming Anthropic during bursts.
3. **Offload Puppeteer to Browserless.io** if SPA-heavy traffic becomes a meaningful share. Removes the 500 MB/render memory headache.
4. **Edge-cache terminal `/p/[id]` responses** — headers-only change, drops Postgres reads on the polling path to near-zero for completed crawls.

Each is independently shippable; none blocks the others. All are sketched in `docs/SCALING.md` with cost/effort estimates.
