# Observability

What's wired for error tracking and log visibility, what's deliberately
deferred, and where to look when something breaks in production.

---

## 1. What we run today

**Sentry (error tracking).** Grouped issues, stack traces with source
maps, on-error session replay, release tagging tied to Vercel deploys.
Free tier: 5 K errors, 10 K performance events, 50 replays per month,
30-day retention, 1 seat. Sufficient for this project's scale.

**Vercel runtime log viewer (built-in).** 1-hour retention on Hobby
plan, longer on Pro. Useful for tailing during a deploy or reproducing
a recent issue; not a durable aggregate.

**That's it.** No external log drain (Vercel Log Drains is Pro-only —
same gate that blocks the Axiom / Datadog / Better Stack integrations
on the Marketplace).

---

## 2. Where Sentry lives in the codebase

Five files, all owned by the Sentry Next.js SDK convention:

| File | Role |
|---|---|
| `instrumentation.ts` | Next.js `register()` hook; loads runtime-specific config at boot and forwards `onRequestError` to `Sentry.captureRequestError`. |
| `instrumentation-client.ts` | Browser SDK init. Session replay is on-error-only (session sampling 0, error sampling 100 %) so we stay inside the 50/month replay quota. Text masked and media blocked for privacy. |
| `sentry.server.config.ts` | Node runtime init. Includes `ignoreErrors` for expected-and-handled failures — see §3. |
| `sentry.edge.config.ts` | Middleware runtime init. |
| `app/global-error.tsx` | App Router root error boundary. Catches uncaught React render errors that escape every lower boundary and reports them to Sentry before rendering the Next fallback. |

All five live at the project root because Next.js (not Sentry) pins
their location. Moving them into a subfolder breaks the convention.

Source-map upload is handled by `withSentryConfig` in `next.config.ts`,
using the `SENTRY_AUTH_TOKEN` / `SENTRY_ORG` / `SENTRY_PROJECT` env
vars injected by the Vercel Sentry integration. Maps are deleted from
the build folder after upload (SDK default) so they don't ship in the
public bundle.

---

## 3. What Sentry ignores on purpose

These show up in `sentry.server.config.ts` → `ignoreErrors`. They're
things we already catch and handle gracefully; letting them open as
new Sentry issues would drown out real signal.

| Pattern | Source | Why ignored |
|---|---|---|
| `UnsafeUrlError` / `Unsafe URL (…)` / `forbidden IP range` | `lib/crawler/ssrf.ts` | User submitted a private / metadata / loopback URL. Product behaviour, not a bug. |
| `Bot challenge page` | `lib/crawler/fetchPage.ts` | Cloudflare / PerimeterX / similar WAF interstitial on the target site. Nothing we can fix. |
| `Response too large` | `lib/crawler/readBounded.ts` | Target response exceeded the 5 MB / 10 MB cap. By design. |
| `^HTTP 4\d\d` | `lib/crawler/fetchPage.ts` | Target returned 4xx. User-provided URL; not our bug. |
| `^Timeout$` | `lib/crawler/fetchPage.ts`, `lib/crawler/sitemap.ts`, etc. | Target site didn't respond within the per-fetch budget. |
| `Exceeded time budget` | `lib/crawler/pipeline.ts` | Pipeline hit the 270 s cap. Already written as `status: "failed"` on the job row. |

Adjust the list if one of these starts meaning something real (e.g.
timeouts from a specific target becoming a customer complaint).

---

## 4. How the app feeds Sentry

`lib/log.ts` is the chokepoint.

- **`debugLog(context, data)`** — Error payloads forward to
  `Sentry.captureException(data, { tags: { context } })`. Non-Error
  payloads are left as `console.warn` only (no stack = no grouping
  signature, and they're usually routine trace info).
- **`errorLog(context, data)`** — Error payloads → `captureException`
  as above. String payloads → `captureMessage(\`[${context}] ${data}\`,
  { level: "error", tags: { context } })`. This is how the monitor
  cron's per-URL failure lines (`${url}: ${message}`) surface as
  grouped Sentry issues instead of only console lines.

Two call sites skip Sentry on purpose:

- **`lib/rateLimit.ts`** — the `console.warn` on Upstash fail-open
  goes direct to stdout, not through `errorLog`. Rationale: we want
  it in the Vercel logs feed but don't want to page on every transient
  Redis blip. If a persistent Redis outage ever becomes a problem,
  wire `errorLog` in here so it promotes to a Sentry issue.
- **`lib/jobQueue.ts`** — the `[enqueueCrawl] branch=…` info line is
  `console.info` only. A sustained jump in `fallback:*` events would
  mean QStash state has drifted; worth re-examining the routing
  strategy, not worth alerting on every occurrence.

---

## 5. Where to look when something breaks

In rough order of useful-first:

1. **Sentry dashboard → Issues.** Grouped errors with stack traces,
   breadcrumbs, replay clips. Filter by `context` tag to scope to one
   call site (`monitor`, `llmEnrich.enrichBatch`, `worker.crawl`,
   `store.updateJob.*`, etc.).
2. **Vercel runtime logs** (Dashboard → project → Logs). Short
   retention, but useful for tailing during a deploy or catching the
   `console.warn` / `console.info` lines that don't forward to Sentry.
3. **Supabase dashboard → SQL editor.** `SELECT ... FROM jobs WHERE
   status = 'failed' ORDER BY updated_at DESC` for crawl-level
   failures with their scrubbed error strings.
4. **Upstash dashboards.** QStash delivery events (retries, DLQ),
   Redis command usage (rate-limit traffic).
5. **Anthropic console.** Token / RPM / TPM graphs; useful when
   enrichment quality degrades suddenly.

---

## 6. What a "production-grade" setup would add

Deferred by design; worth listing for a reviewer.

### The big next step: Axiom on Vercel Pro

**Gate:** Vercel **Log Drains** — the mechanism every traditional log
aggregator uses for auto-ingestion from Vercel — is a Pro-tier-only
feature ($20/mo). That's why Axiom / Datadog / Better Stack show as
unavailable on the current Hobby plan. Upgrading to Pro unlocks all
of them simultaneously; the tighter hourly-cron cadence is an
independent bonus of the same upgrade.

**Recommended choice: Axiom** via its Vercel Marketplace integration.
- Native one-click install (unified billing through Vercel once on Pro).
- Free tier: **0.5 GB/month ingest, 30-day retention** — fits this
  app's volume comfortably.
- APL query language; tail + dashboard + alert-rules in one product.

**What Axiom adds that Sentry doesn't catch:**

| Signal | Where it lives today | Value of Axiom capturing it |
|---|---|---|
| `[rateLimit] Upstash call failed, FAILING OPEN: …` | `lib/rateLimit.ts`, `console.warn` | Trend: is Redis intermittently flaky, or did we silently disable rate limiting platform-wide? Sentry skips it by design (not an Error). |
| `[enqueueCrawl] branch=qstash\|fallback:*` | `lib/jobQueue.ts`, `console.info` | Alert when `fallback:*` rate spikes — means QStash state has drifted, queue is quietly not getting used. |
| `[pipeline]` step durations / success rates | `lib/store.ts` updates + implicit from status transitions | P50 / P95 crawl duration, % hitting `partial`, deterministic-fallback rate on LLM calls. Sentry traces show slices of this but aren't a time-series tool. |
| Successful crawls + cache-hit counts | `api/p` response paths, no dedicated log line | Answers "how many unique URLs today", "cache-hit ratio over the week" — not possible without an aggregated log stream. |

Rule of thumb: **Sentry answers "what broke"; Axiom answers "is the
system healthy and are the trends moving the right way."** At
take-home scale the first question dominates. At production scale the
second becomes equally important.

**Migration effort if we go there:** ~30 minutes. One-click install
from the Vercel Marketplace provisions the Axiom dataset and sets up
the log drain. The app already emits structured-enough log lines
(`[context] message`) that Axiom can parse as events without a code
change. A later polish pass would move `lib/log.ts` to a JSON logger
(`pino`) so Axiom can index by field — makes queries like
"count denials by userId per hour" trivial instead of regex-heavy.

### Other deferred items

- **Sentry Performance at non-10 % sampling.** We ship `tracesSampleRate:
  0.1`. Raise if we actually need trace coverage.
- **Release-health alerts.** Auto-alert on error-rate regression per
  release (Sentry feature). One toggle in the Sentry dashboard.
- **Vercel Speed Insights.** Real-user Core Web Vitals. Free tier.
  Only matters if frontend perf starts being a complaint.
- **Structured-data logger** (`pino` / `winston`). Prerequisite for
  field-indexed queries in whichever aggregator we pick.
