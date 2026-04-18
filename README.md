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
- IP-keyed rate limiting for anon traffic, user-keyed for signed-in users

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
- For production deploys: a **Vercel** account linked to the repo

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

| Variable | Where | Purpose |
|---|---|---|
| `ANTHROPIC_API_KEY` | server | Claude API for page enrichment |
| `SUPABASE_URL` | server | Supabase project URL |
| `SUPABASE_ANON_KEY` | server | Supabase anon key (used for server auth helpers) |
| `SUPABASE_SERVICE_ROLE_KEY` | server | Bypasses RLS for store writes — **never expose to the client** |
| `NEXT_PUBLIC_SUPABASE_URL` | browser | Same URL, exposed for the browser Supabase client |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | browser | Anon key exposed to the browser |
| `CRON_SECRET` | server | Secret Vercel injects as `Authorization: Bearer …` on cron-invoked calls to `/api/monitor`. Route fails closed if unset. Generate with `openssl rand -hex 32`. |

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

The repo is already configured for Vercel (see [`vercel.json`](./vercel.json)): 300s max duration on the crawl + monitor routes, and a daily cron on `/api/monitor`.

### 1. Import the repo

1. [vercel.com/new](https://vercel.com/new) → import this repo. Framework preset: **Next.js** (auto-detected).
2. Don't deploy yet — set env vars first.

### 2. Environment variables

In **Project Settings → Environment Variables**, add all seven keys from the table above for the **Production**, **Preview**, and **Development** scopes. The `NEXT_PUBLIC_*` pair is safe to expose; the others must stay server-only.

Alternatively, using the [Vercel CLI](https://vercel.com/docs/cli):

```bash
vercel link
vercel env add ANTHROPIC_API_KEY production
# …repeat for each key, or push a local .env.local:
vercel env pull .env.local   # read back after
```

### 3. Point Supabase at the production URL

After the first deploy, copy the production domain and add it to Supabase:
- **Authentication → URL Configuration → Site URL**: `https://<your-domain>`
- **Authentication → URL Configuration → Redirect URLs**: include `https://<your-domain>/auth/callback`

Also update each OAuth provider's allowed callback to the Supabase callback URL (unchanged from the local setup) — OAuth flows go browser → Supabase → app, so the provider only needs to know about Supabase.

### 4. Cron + function limits

- `vercel.json` schedules `/api/monitor` at `0 0 * * *` (daily, midnight UTC). On **Hobby** this is the most frequent allowed cadence; on **Pro** you can change it to `0 * * * *` for hourly.
- `/api/p` and `/api/monitor` are set to `maxDuration: 300` — Fluid Compute default, available on all plans as of the 2025 timeout bump.
- Vercel automatically injects `CRON_SECRET` as the `Authorization: Bearer …` header on cron invocations. If the env var is unset the route fails closed (`401`).

### 5. Verify

After deploying:

```bash
# Cron endpoint should 401 without the header
curl -i https://<your-domain>/api/monitor
# Should 200 with the right header
curl -s -H "Authorization: Bearer $CRON_SECRET" https://<your-domain>/api/monitor | jq
```

Open the site, sign in with GitHub or Google, generate a URL, and check the dashboard.

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

lib/
  config.ts                       Tunable constants (TTLs, limits, rate limits)
  env.ts                          Typed env-var access with fail-fast checks
  log.ts                          Structured logging helper
  rateLimit.ts                    In-memory token-bucket rate limiter
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

middleware.ts                     Supabase auth cookie refresh
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
- [`docs/SECURITY.md`](./docs/SECURITY.md) — threat model and implemented controls
- [`docs/TESTING.md`](./docs/TESTING.md) — manual test playbook covering golden paths and edge cases
