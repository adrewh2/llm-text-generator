# llms.txt Generator

A web app that crawls any website and produces a spec-compliant [`llms.txt`](https://llmstxt.org) file describing its most important pages for LLM consumption.

Paste a URL, the app discovers pages (sitemap → robots → link-following, with a Puppeteer fallback for SPAs), extracts metadata, uses an LLM to classify each page and write a concise description, scores and groups the pages into sections, and assembles the final `llms.txt`.

## Features

**Crawler**
- Discovery via `sitemap.xml`, `robots.txt`, and BFS link traversal (respects `Disallow` rules)
- Markdown-variant probing (prefers `.md` links per the spec)
- SPA detection + headless-Chrome fallback via `puppeteer` (local) / `@sparticuz/chromium` (Vercel)
- Worker-pool concurrency with a default politeness delay; honors `robots.txt` `Crawl-delay` as a shared cross-worker clock, capped at 10 s
- SSRF-hardened: every outbound fetch resolves DNS and rejects RFC1918 / loopback / link-local / metadata IPs (`lib/crawler/ssrf.ts`)
- Streaming body reads with hard byte caps so a server that omits or lies about `Content-Length` can't OOM us (`lib/crawler/readBounded.ts`)

**LLM enrichment**
- Per-page classification (`doc`, `api`, `example`, `blog`, `changelog`, `about`, …) via Claude
- LLM-written descriptions, section names, and scoring — tuned to the site's inferred genre
- Site-genre detection (`developer_docs`, `ecommerce`, `personal_site`, …) adapts section naming

**Output**
- Spec-compliant `llms.txt` assembly with generated preamble and importance-ordered sections
- Curated external references included in output
- In-browser validator + editable result + copy / download

**Accounts + shared cache**
- Supabase OAuth sign-in (GitHub + Google)
- Globally-shared page cache: one canonical result per URL, reused across users
- 24-hour TTL — stale pages trigger a fresh crawl; old result is preserved until the new one succeeds
- Per-user dashboard of every page you've generated with infinite scroll, remove-from-history action, and bulk ZIP download
- Row-Level Security on every table; service-role key used only server-side
- Two-bucket rate limiter on `POST /api/p` — a loose **SUBMIT** floor (60/hr anon, 300/hr auth) on every POST, and a tight **NEW_CRAWL** quota (3/hr anon, 10/hr auth) charged only when a submission dispatches a fresh pipeline run. Keyed by user id when signed in, by client IP when not. Upstash Redis state in production, in-memory fallback for local dev.

**Durable queue + observability**
- Crawl dispatch via **Upstash QStash** — signed webhook POSTs to `/api/worker/crawl`, retry-on-non-2xx up to 3 tries, `waitUntil(runCrawlPipeline(...))` fallback for local dev
- **Sentry** error tracking with on-error session replay, grouped by `context` tag; expected failures (SSRF, bot-challenge, timeouts, budget-exhaust) filtered from issue noise

**Monitoring**
- Every generated page is monitored by default — the dashboard shows a passive "Checked X ago" status
- Two refresh paths:
  - **Daily cron** — Vercel Cron (midnight UTC) computes a signature over each monitored site's sitemap + homepage; on mismatch, a full re-crawl is dispatched and `pages.result` is refreshed. Daily is the Vercel Hobby-plan ceiling; the schedule string in `vercel.json` can be tightened to hourly (`0 * * * *`) on a Pro plan.
  - **Request-driven TTL** — when anyone requests a URL whose cached result is older than 24h (`PAGE_TTL_HOURS` in `lib/config.ts`), a fresh crawl is triggered on the spot. The old `pages.result` is preserved until the new one completes, so no request is ever served an empty result.
- Cron also sweeps: jobs wedged in a non-terminal status past the pipeline budget (see `STUCK_JOB_AFTER_MS`) are force-failed so they don't block future submissions; pages not requested in the last 5 days are quietly un-monitored
- Re-crawl fan-out runs through the QStash queue (`waitUntil` fallback in dev) — see `app/api/monitor/route.ts`

## Prerequisites

- **Node.js ≥ 20** (see `engines` in `package.json`)
- A **Supabase** project (free tier is fine) — [supabase.com](https://supabase.com)
- An **Anthropic API key** — [console.anthropic.com](https://console.anthropic.com)
- For production: a **Vercel** account linked to the repo plus (all one-click Vercel Marketplace integrations)
  - **Upstash Redis** — rate-limiter state
  - **Upstash QStash** — durable crawl queue
  - **Sentry** (via the Vercel Integrations Marketplace) — error tracking

For **local development** the Upstash / QStash / Sentry pieces are optional: `rateLimit.ts` falls back to in-memory buckets, `jobQueue.ts` falls back to `waitUntil` in-process, and the Sentry SDK no-ops without a DSN. You can run end-to-end with just Supabase + Anthropic.

## Running locally

```bash
git clone <this-repo>
cd llm-text-generator
npm install
cp .env.example .env.local   # fill in the values — see below
npm run dev
```

Open <http://localhost:3000>.

### 1. Create the Supabase project

1. Create a new project at [supabase.com/dashboard](https://supabase.com/dashboard).
2. Open **SQL Editor** → paste the contents of [`supabase/migration.sql`](./supabase/migration.sql) → **Run**. This creates the `pages`, `jobs`, and `user_requests` tables along with RLS policies.
3. In **Project Settings → API**, copy:
   - `Project URL` → `SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_URL`
   - `anon` `public` key → `SUPABASE_ANON_KEY` and `NEXT_PUBLIC_SUPABASE_ANON_KEY`
   - `service_role` `secret` key → `SUPABASE_SERVICE_ROLE_KEY` (server-only, bypasses RLS)

### 2. Configure OAuth providers

The app uses GitHub + Google OAuth via Supabase. In **Authentication → Providers**, enable both:

- **GitHub** — create an OAuth app at [github.com/settings/developers](https://github.com/settings/developers). Authorization callback URL must be `https://<your-project>.supabase.co/auth/v1/callback`.
- **Google** — create OAuth credentials in [Google Cloud Console](https://console.cloud.google.com/apis/credentials). Authorized redirect URI: `https://<your-project>.supabase.co/auth/v1/callback`.

In **Authentication → URL Configuration**, set:
- **Site URL**: `http://localhost:3000` (dev) or your production origin
- **Redirect URLs**: add both `http://localhost:3000/auth/callback` and `https://<your-prod-domain>/auth/callback`

### 3. Fill in `.env.local`

**Required for any deploy (prod or local):**

| Variable | Where | Purpose |
|---|---|---|
| `ANTHROPIC_API_KEY` | server | Claude API for page enrichment. Without it the LLM steps degrade to deterministic fallbacks — the app still produces a spec-valid `llms.txt`, just un-enriched. |
| `SUPABASE_URL` | server | Supabase project URL |
| `SUPABASE_ANON_KEY` | server | Supabase anon key (used for server auth helpers) |
| `SUPABASE_SERVICE_ROLE_KEY` | server | Bypasses RLS for store writes — **never expose to the client** |
| `NEXT_PUBLIC_SUPABASE_URL` | browser | Same URL, exposed for the browser Supabase client |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | browser | Anon key exposed to the browser |
| `CRON_SECRET` | server | Secret Vercel injects as `Authorization: Bearer …` on cron-invoked calls to `/api/monitor`. Route fails closed if unset. Generate with `openssl rand -hex 32`. |

**Required in production, optional locally** (all auto-injected by the respective Vercel Marketplace integrations — see [Deploying to Vercel §2](#2-provision-marketplace-integrations)):

| Variable | Where | Purpose |
|---|---|---|
| `UPSTASH_REDIS_REST_URL` | server | Upstash Redis REST endpoint. Backs the production rate limiter. If unset, `lib/rateLimit.ts` falls back to per-instance in-memory token buckets — fine for `npm run dev`, *not fit for production* (a cold start or autoscale event gives the attacker a fresh bucket). |
| `UPSTASH_REDIS_REST_TOKEN` | server | Token pair for the URL above. |
| `QSTASH_TOKEN` | server | Authenticates publishes to Upstash QStash from `lib/jobQueue.ts`. If absent, the publisher falls back to `waitUntil(runCrawlPipeline(...))` — same instance runs the crawl, no mid-pipeline retry safety. |
| `QSTASH_URL` | server | QStash region-specific base URL (e.g. `https://qstash-us-east-1.upstash.io`). **Required** alongside `QSTASH_TOKEN` for accounts outside `eu-central-1` — without it the SDK silently publishes to the wrong region and messages never land. The Marketplace integration sets this automatically. |
| `QSTASH_CURRENT_SIGNING_KEY` | server | Verifies incoming QStash webhook signatures at `/api/worker/crawl`. |
| `QSTASH_NEXT_SIGNING_KEY` | server | Rotated signing key; SDK accepts either. |
| `QSTASH_WORKER_URL` | server | *Optional.* Explicit callback URL QStash should POST back to. When unset, `resolveWorkerUrl()` in `lib/jobQueue.ts` derives it from `VERCEL_PROJECT_PRODUCTION_URL` (stable public alias — preferred) or `VERCEL_URL` (per-deployment, gated by Deployment Protection). Set this explicitly if you're running a preview deploy or tunneling locally. |
| `NEXT_PUBLIC_SENTRY_DSN` | browser + server | Sentry ingest DSN. Copy from Sentry → Project Settings → Client Keys. Safe to expose — it's an ingest-only identifier. If unset, the Sentry SDK silently no-ops. |
| `SENTRY_AUTH_TOKEN` | build-time | Used by `withSentryConfig` in `next.config.ts` to upload source maps during the Vercel build. Auto-injected by the Vercel Sentry integration. |
| `SENTRY_ORG` | build-time | Sentry org slug, used alongside the auth token for source-map upload. |
| `SENTRY_PROJECT` | build-time | Sentry project slug. |

### Scripts

```bash
npm run dev         # next dev (localhost:3000)
npm run build       # production build
npm start           # serve the production build locally
npm run lint        # eslint
npm run typecheck   # tsc --noEmit
```

### Running the monitor cron locally

[Vercel Cron](https://vercel.com/docs/cron-jobs) only fires on production deployments, so on `localhost` the scheduled daily check never runs — `pages.last_checked_at` only advances when a crawl completes (which stamps it) or when you hit the endpoint manually:

```bash
source .env.local
curl -s -H "Authorization: Bearer $CRON_SECRET" http://localhost:3000/api/monitor | jq
# { "checked": N, "changed": M, "swept": K, "stuckFailed": J, "recrawls": [...], "errors": [] }
```

Each manual call does the full cron cycle: force-fail stuck jobs → sweep stale pages → compute signatures → dispatch re-crawls on change. The auth header is the same `CRON_SECRET` Vercel injects in production, so this is an exact equivalent.

## Deploying to Vercel

The repo is already configured for Vercel (see [`vercel.json`](./vercel.json)): 300s max duration on the crawl + monitor + worker routes, and a daily cron on `/api/monitor`.

### 1. Import the repo

1. [vercel.com/new](https://vercel.com/new) → import this repo. Framework preset: **Next.js** (auto-detected).
2. Don't deploy yet — provision integrations and set env vars first.

### 2. Provision Marketplace integrations

Three integrations handle infrastructure. All are one-click installs from the Vercel dashboard that auto-inject env vars into **Production** + **Preview** scopes.

1. **Upstash** (Redis + QStash) — Dashboard → your project → **Integrations** tab → Marketplace → **Upstash** → Add Integration → this project. Provisions a Redis instance (rate limiter) and a QStash account (crawl queue) together. Injects `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`, `QSTASH_TOKEN`, `QSTASH_URL`, `QSTASH_CURRENT_SIGNING_KEY`, `QSTASH_NEXT_SIGNING_KEY`.
2. **Sentry** — **Integrations** tab → Marketplace → **Sentry** → Add Integration. Creates or links a Sentry project and injects `SENTRY_AUTH_TOKEN`, `SENTRY_ORG`, `SENTRY_PROJECT` for build-time source-map upload. Then copy the DSN from Sentry → Project Settings → Client Keys and add it as `NEXT_PUBLIC_SENTRY_DSN`:
   ```bash
   vercel env add NEXT_PUBLIC_SENTRY_DSN production
   ```
3. **(Optional) Log drain for deeper log aggregation** — Axiom / Datadog / Better Stack via the same Integrations Marketplace. Requires Vercel **Pro**. Not necessary for the take-home; see [`docs/OBSERVABILITY.md`](./docs/OBSERVABILITY.md) for the rationale.

### 3. Set the remaining env vars

The Marketplace integrations don't provision your own keys (Anthropic, Supabase, CRON_SECRET). Add them in **Project Settings → Environment Variables** for all three scopes, or via CLI:

```bash
vercel link
vercel env add ANTHROPIC_API_KEY production
vercel env add SUPABASE_URL production
vercel env add SUPABASE_ANON_KEY production
vercel env add SUPABASE_SERVICE_ROLE_KEY production
vercel env add NEXT_PUBLIC_SUPABASE_URL production
vercel env add NEXT_PUBLIC_SUPABASE_ANON_KEY production
vercel env add CRON_SECRET production
# ...then pull everything back for local parity
vercel env pull .env.local
```

The `NEXT_PUBLIC_*` pair is safe to expose; the others must stay server-only.

### 4. Point Supabase at the production URL

After the first deploy, copy the production domain and add it to Supabase:
- **Authentication → URL Configuration → Site URL**: `https://<your-domain>`
- **Authentication → URL Configuration → Redirect URLs**: include `https://<your-domain>/auth/callback`

Also update each OAuth provider's allowed callback to the Supabase callback URL (unchanged from the local setup) — OAuth flows go browser → Supabase → app, so the provider only needs to know about Supabase.

### 5. Cron + function limits + QStash callback

- `vercel.json` schedules `/api/monitor` at `0 0 * * *` (daily, midnight UTC). On **Hobby** this is the most frequent allowed cadence; on **Pro** you can change it to `0 * * * *` for hourly.
- `/api/p`, `/api/monitor`, and `/api/worker/crawl` are set to `maxDuration: 300` — Fluid Compute default, available on all plans as of the 2025 timeout bump.
- Vercel automatically injects `CRON_SECRET` as the `Authorization: Bearer …` header on cron invocations. If the env var is unset the route fails closed (`401`).
- **QStash callbacks** land on the worker route via the stable production alias (`VERCEL_PROJECT_PRODUCTION_URL`, e.g. `llm-text-generator.vercel.app`), not the per-deployment URL (which is gated by Vercel's Deployment Protection). `lib/jobQueue.ts` → `resolveWorkerUrl()` prefers the alias; no setup required unless you're on a preview deploy or behind a custom domain.

### 6. Verify

After deploying:

```bash
# Cron endpoint should 401 without the header
curl -i https://<your-domain>/api/monitor
# Should 200 with the right header
curl -s -H "Authorization: Bearer $CRON_SECRET" https://<your-domain>/api/monitor | jq
# { "checked": N, "changed": M, "swept": K, "stuckFailed": J, "recrawls": [...], "errors": [] }

# End-to-end crawl kick-off (will be rate-limited on repeated calls)
curl -s -X POST https://<your-domain>/api/p \
  -H "Content-Type: application/json" \
  -d '{"url":"https://llmstxt.org"}' | jq
```

**Verify observability** — force a real pipeline error (DNS resolution failure) and confirm Sentry catches it:
```bash
curl -s -X POST https://<your-domain>/api/p \
  -H "Content-Type: application/json" \
  -d '{"url":"https://this-domain-definitely-does-not-exist-asdfghjkl.com"}'
```
Then open your Sentry project's **Issues** tab; the error should appear within ~30 s with `context: worker.crawl` or `context: pipeline` tag. Filter by the `context` tag to scope to a single call site.

**Verify the queue** — Upstash Console → QStash → **Events**. You should see a signed POST to `https://<your-domain>/api/worker/crawl` per submitted URL, with status `Delivered`.

Finally, open the site, sign in with GitHub or Google, generate a URL, and check the dashboard.

## Architecture

```
app/
  page.tsx, LandingClient.tsx     Landing page / URL input
  p/[id]/page.tsx                 Result + simulated-progress view
  dashboard/                      Per-user page history + monitor status
  login/                          OAuth sign-in (GitHub / Google)
  auth/callback/                  Supabase auth callback
  api/p/                          POST create a crawl
  api/p/[id]/                     GET job status
  api/p/request/                  DELETE remove URL from user's history
  api/pages/                      GET paginated user history (dashboard)
  api/pages/download/             GET bulk-download history as a zip
  api/monitor/                    GET cron entrypoint (CRON_SECRET gated)
  api/worker/crawl/               POST QStash-signed crawl worker — the actual pipeline host
  global-error.tsx                App Router root error boundary → Sentry

lib/
  config.ts                       Tunable constants (TTLs, limits, rate limits, retries)
  env.ts                          Typed env-var access with fail-fast checks
  log.ts                          debugLog + errorLog — forward Errors to Sentry
  rateLimit.ts                    Two-bucket token limiter (SUBMIT + NEW_CRAWL), Upstash Redis + in-memory fallback
  jobQueue.ts                     QStash publish + waitUntil fallback
  store.ts                        Supabase-backed page + job + user-request store
  supabase/                       Browser + SSR client factories
  crawler/
    pipeline.ts                   Orchestrates crawl → enrich → score → assemble
    monitor.ts                    Signature + change detection for cron
    discover.ts, sitemap.ts,      URL discovery
      robots.ts
    fetchPage.ts, safeFetch.ts,   HTTP fetch with SSRF guard + size-capped streaming read + .md variant probe
      markdownProbe.ts, ssrf.ts,
      readBounded.ts
    spaCrawler.ts                 Puppeteer fallback for JS-rendered sites
    extract.ts                    Cheerio-based metadata extraction
    classify.ts, llmEnrich.ts     Claude-powered classification + descriptions
    genre.ts, siteName.ts         Site-level inference
    score.ts, group.ts            Importance scoring + section grouping
    urlLabel.ts                   Human-friendly labels / filenames
    assemble.ts                   Final llms.txt string assembly
    validate.ts                   Spec validator
    url.ts, types.ts              Shared URL utils + types

instrumentation.ts                Next.js hook — loads sentry.{server,edge}.config by runtime
instrumentation-client.ts         Sentry browser SDK init (on-error replay)
sentry.server.config.ts           Node runtime init + ignoreErrors filter
sentry.edge.config.ts             Edge runtime init (for middleware)
middleware.ts                     Supabase auth cookie refresh + /dashboard gate
next.config.ts                    CSP + security headers + withSentryConfig wrapper
supabase/migration.sql            Schema + RLS policies
vercel.json                       Function limits + cron schedule
```

### Data model

- **`pages`** — one row per URL (globally shared cache). `result` holds the generated `llms.txt`. Monitoring state (`monitored`, `last_checked_at`, `content_signature`, `last_requested_at`) lives here.
- **`jobs`** — one row per crawl execution, FK → `pages.url`. Multiple jobs can exist per page (e.g. TTL refreshes, monitor-triggered re-crawls).
- **`user_requests`** — tracks which pages a signed-in user has generated; powers the dashboard.

### Security

RLS is enabled on every table. All app traffic to Supabase goes through server-only code using the **service-role key**, which bypasses RLS. The policies below define what *would* happen if someone queried Supabase directly with the anon key:

- `pages` / `jobs`: public read (these results are the product)
- `user_requests`: `auth.uid() = user_id` — one user cannot read another user's history even with the anon key

See [`docs/SECURITY.md`](./docs/SECURITY.md) for the full threat model — SSRF, abuse / cost controls, prompt-injection containment, cross-user data-leak prevention, and classic web-app risks.

## Further reading

- [`docs/DESIGN.md`](./docs/DESIGN.md) — pipeline rationale, crawl strategy, LLM prompt design, tradeoffs
- [`docs/SYSTEM-DESIGN.md`](./docs/SYSTEM-DESIGN.md) — Mermaid diagrams: component graph + crawl-request lifecycle
- [`docs/SECURITY.md`](./docs/SECURITY.md) — threat model and implemented controls
- [`docs/OBSERVABILITY.md`](./docs/OBSERVABILITY.md) — Sentry wiring, what's filtered, where to look when something breaks
- [`docs/SCALING.md`](./docs/SCALING.md) — phase-2 scaling plan: shipped work + what's next at each ceiling
- [`docs/PERFORMANCE.md`](./docs/PERFORMANCE.md) — honest throughput math across free / paid / enterprise tiers
- [`docs/TESTING.md`](./docs/TESTING.md) — manual test playbook covering golden paths and edge cases
