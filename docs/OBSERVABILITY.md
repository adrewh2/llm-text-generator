# Observability

What's wired for error tracking and log visibility, what's deliberately
deferred, and where to look when something breaks in production.

---

## 1. What we run today

**Sentry (error tracking).** Grouped issues, stack traces with source
maps, on-error session replay, release tagging tied to Vercel deploys.
The free tier is comfortably enough for this project's volume (see
Sentry's plans page for current limits); the two constraints we
actively manage against it are replay sampling (on-error only,
configured in `instrumentation-client.ts`) and noise filtering
(§3 below).

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

`sentry.server.config.ts` → `ignoreErrors` filters the classes of
failure we expect and already handle. Letting them open as new issues
would drown the signal. The current list covers:

- **SSRF rejections** — user submitted a private / metadata / loopback URL. Product behaviour.
- **Target-site 4xx** — the submitted URL returned 4xx. Not our bug.
- **Target-site timeouts** — the site didn't respond within the per-fetch budget.
- **Bot-challenge interstitials** — Cloudflare / PerimeterX / similar WAF pages. Nothing we can fix.
- **Response-too-large** — target exceeded the configured byte cap. By design.
- **Pipeline-budget exhaust** — we hit the wall-clock cap; already recorded as `status: failed` on the job row.

See the file for the exact regex patterns; that's the source of truth
and it changes more often than this doc should. Adjust the list if
one of these starts meaning something real (e.g. timeouts from one
specific target becoming a customer complaint).

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

One call site skips Sentry on purpose:

- **`lib/upstash/jobQueue.ts`** — the `[enqueueCrawl] branch=… jobId=…`
  info line is `console.info` only. A sustained jump in `fallback:*`
  events would mean QStash state has drifted; worth re-examining the
  routing strategy, not worth alerting on every occurrence.

One call site promotes to Sentry on purpose:

- **`lib/upstash/rateLimit.ts`** — the Upstash fail-open path routes
  through `errorLog("rateLimit.upstash", …)` so a persistent Redis
  outage surfaces as a Sentry issue. A misconfigured `UPSTASH_*` env
  would otherwise *silently disable* rate limiting platform-wide,
  which is a security concern that warrants alerting, not just a log
  line. Transient blips will still hit Sentry; grouping by context
  makes it easy to see whether it's a one-off or a pattern.

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

## 6. What a production-grade setup would add

Deferred by design; worth listing for a reviewer.

**The big next step — an external log aggregator** (Axiom is the natural choice via the Vercel Marketplace, but Datadog / Better Stack would work too). Sentry answers *what broke*; a log aggregator answers *is the system healthy, are the trends moving the right way* — crawl-duration percentiles, cache-hit ratio, Upstash-fail-open frequency, queue-fallback rate. These signals live in `console.warn` / `console.info` lines today (they don't belong in Sentry), so they're invisible beyond the short Vercel-logs retention window.

The gate on shipping it is Vercel Pro — log drains are a Pro-tier feature. Once we're on Pro, any of the marketplace aggregators is a one-click install; the app's log lines are already `[context] message`-shaped and parse cleanly as events. A polish pass on `lib/log.ts` to emit JSON (e.g. via `pino`) would make field-indexed queries easier, but isn't a prerequisite.

**Other items worth listing:**

- **Sentry Performance sampling.** We ship at 10 %. Raise when actively chasing a perf regression.
- **Release-health alerts.** One toggle in the Sentry dashboard.
- **Vercel Speed Insights.** Real-user Core Web Vitals. Flip on if frontend performance starts being a complaint.
