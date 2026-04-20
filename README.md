# llms.txt Generator

A web app that turns any website into a spec-compliant [`llms.txt`](https://llmstxt.org) file — a machine-readable index an LLM can use to understand what the site is and which pages matter.

Enter a URL and get back a curated `llms.txt`: an H1 with the site's name, a short intro, and the site's most important pages grouped into sections like Docs, Guides, Products, etc. Sign in to save a history of everything you've generated and export the collection as a zip.

## What it does

- **Crawls a site intelligently.** Reads the site's `sitemap.xml` and `robots.txt`, explores outward from the homepage, and — when a site is a JavaScript shell (SPA) — renders it through headless Chromium. Before crawling, an LLM re-orders the candidate URLs by likely value so the page budget is spent on the pages an LLM reader would actually want.
- **Detects the site's primary language** from the homepage and prioritises same-language URLs, so a Japanese-primary site produces a coherent Japanese `llms.txt` rather than getting swamped by English alternates.
- **Classifies and scores each page** with Claude, combining the LLM's judgment with deterministic quality signals (description presence, `.md` sibling per the spec, structured data, URL shape).
- **Assembles a spec-compliant file**: H1 + blockquote summary + intro paragraph + `## Section` headings with importance-ordered bullet lists. Curated external references (spec links, upstream docs, related projects the site links to itself) are included.
- **Caches globally.** One canonical result per URL, shared across all users. A daily cron detects site changes via a signature over the sitemap + homepage and re-crawls only when something actually drifted. User re-requests can also trigger a regeneration if the page's TTL expired.
- **Account features** for signed-in users: dashboard of every URL you've generated, infinite scroll + bulk ZIP export, one-click "add to dashboard" when viewing a shared result URL.
- **Production-hardened**: SSRF guards on every outbound fetch (with per-redirect re-validation), two-bucket rate limiter (SUBMIT floor + NEW_CRAWL quota), prompt-injection defence on every LLM call, Row-Level Security on every table, Sentry error tracking, and a durable QStash queue for crawl dispatch with fallback systems for local dev.

Full detail on any of these lives in the docs under [`docs/`](./docs) — see [Further reading](#further-reading) below.

## Prerequisites

- **Node.js ≥ 20** (see `engines` in `package.json`)
- A **Supabase** project (free tier is fine) — [supabase.com](https://supabase.com)
- An **Anthropic API key** — [console.anthropic.com](https://console.anthropic.com)
- For production: a **Vercel** account linked to the repo plus three one-click Vercel Marketplace integrations:
  - **Upstash Redis** — rate-limiter state
  - **Upstash QStash** — durable crawl queue
  - **Sentry** — error tracking

For **local development** the Upstash / QStash / Sentry pieces are optional: `rateLimit.ts` falls back to in-memory buckets, `jobQueue.ts` falls back to `waitUntil` in-process, and the Sentry SDK no-ops without a DSN. You can run end-to-end with just Supabase + Anthropic.

## Running locally

The dev server won't be functional until the Supabase project and env
vars below are in place — Supabase is the hard dependency (schema,
auth, session cookie). Walk through this in order:

1. Clone + install (below).
2. [Create the Supabase project](#creating-the-supabase-project) — provision it and run the schema migration.
3. [Configure OAuth providers](#configuring-oauth-providers) — needed only if you want to test the signed-in flow locally. The anon path works without it.
4. [Fill in `.env.local`](#filling-in-envlocal) — with the Supabase keys from step 2 (and an Anthropic API key so LLM enrichment actually runs; the app falls back to deterministic defaults if you skip it).
5. Start the dev server (below).

```bash
# Step 1 — clone + install
git clone https://github.com/hanstah/llm-text-generator.git
cd llm-text-generator
npm install

# Steps 2–4 — complete the numbered sections below, then:
cp .env.example .env.local   # fill in with keys obtained

# Step 5 — run
npm run dev
```

Open <http://localhost:3000>.

### Creating the Supabase project

1. Create a new project at [supabase.com/dashboard](https://supabase.com/dashboard).
2. Open **SQL Editor** → paste the contents of [`supabase/migration.sql`](./supabase/migration.sql) → **Run**. This creates the `pages`, `jobs`, and `user_requests` tables along with RLS policies.
3. In **Project Settings → API**, copy:
   - `Project URL` → `SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_URL`
   - `anon` `public` key → `SUPABASE_ANON_KEY` and `NEXT_PUBLIC_SUPABASE_ANON_KEY`
   - `service_role` `secret` key → `SUPABASE_SERVICE_ROLE_KEY` (server-only, bypasses RLS)

### Configuring OAuth providers

The app uses GitHub + Google OAuth via Supabase. In **Authentication → Providers**, enable both:

- **GitHub** — create an OAuth app at [github.com/settings/developers](https://github.com/settings/developers). Authorization callback URL must be `https://<your-project>.supabase.co/auth/v1/callback`.
- **Google** — create OAuth credentials in [Google Cloud Console](https://console.cloud.google.com/apis/credentials). Authorized redirect URI: `https://<your-project>.supabase.co/auth/v1/callback`.

Still in the Supabase dashboard, open **Authentication → URL Configuration** (this is Supabase's own allowlist, separate from the provider-side redirect URIs above). Set:

- **Site URL**: `http://localhost:3000` (dev) or your production origin
- **Redirect URLs**: add both `http://localhost:3000/auth/callback` and `https://<your-prod-domain>/auth/callback`

The full redirect chain is: browser → GitHub/Google (which has the Supabase callback in its allowlist) → Supabase (which has our `/auth/callback` in its allowlist) → app. Each hop needs its own allowlist entry.

### Filling in `.env.local`

**Required for any deploy (prod or local):**

| Variable                        | Where   | Purpose                                                                                                                                                                                  |
| ------------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ANTHROPIC_API_KEY`             | server  | Claude API for page enrichment. Absent → LLM steps degrade to deterministic fallbacks; output is still spec-valid, just un-enriched.                                                     |
| `SUPABASE_URL`                  | server  | Supabase project URL.                                                                                                                                                                    |
| `SUPABASE_ANON_KEY`             | server  | Supabase anon key (for server-side auth helpers).                                                                                                                                        |
| `SUPABASE_SERVICE_ROLE_KEY`     | server  | Bypasses RLS — **server-only; never ship to the browser**.                                                                                                                               |
| `NEXT_PUBLIC_SUPABASE_URL`      | browser | Same URL, exposed to the browser client.                                                                                                                                                 |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | browser | Anon key, exposed to the browser.                                                                                                                                                        |
| `CRON_SECRET`                   | server  | Random string you generate (`openssl rand -hex 32`). Vercel Cron sends it as `Authorization: Bearer …` to `/api/monitor`, which timing-safe-compares. Unset ⇒ the endpoint fails closed. |

**Required in production, optional locally** — all auto-injected by Marketplace integrations (see [Deploying to Vercel §2](#2-provision-marketplace-integrations)).

| Variable                                                                                 | Purpose                                                                                                                                                                                                                                                                     |
| ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN`                                    | Back the production rate limiter. Vercel deploys fail fast at module load if either is missing (the in-memory fallback isn't safe in prod — see [`SECURITY.md §2`](./docs/SECURITY.md#2-abuse--rate-limiting)).                                                             |
| `QSTASH_TOKEN` + `QSTASH_URL` + `QSTASH_CURRENT_SIGNING_KEY` + `QSTASH_NEXT_SIGNING_KEY` | Authenticate and sign the crawl queue. Missing `QSTASH_TOKEN` ⇒ `waitUntil` fallback (no retry durability); mis-configured region for `QSTASH_URL` ⇒ silent drops — documented in [`SCALING.md §4`](./docs/SCALING.md#4-integration-gotchas-lessons-from-shipping-phase-2). |
| `QSTASH_WORKER_URL`                                                                      | _Optional._ Explicit callback URL override; usually unnecessary (see SCALING.md §4).                                                                                                                                                                                        |
| `NEXT_PUBLIC_SENTRY_DSN`                                                                 | Sentry ingest DSN (safe to expose). Unset ⇒ SDK no-ops.                                                                                                                                                                                                                     |
| `SENTRY_AUTH_TOKEN` + `SENTRY_ORG` + `SENTRY_PROJECT`                                    | Build-time, for source-map upload via `withSentryConfig`.                                                                                                                                                                                                                   |

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

### 5. Platform config

`vercel.json` already sets the cron schedule (`/api/monitor` daily — tighten to hourly on Pro) and raises `maxDuration` on the long-running routes. Vercel Cron injects `CRON_SECRET` as the `Authorization: Bearer …` header automatically. QStash callbacks land on the stable production alias out of the box; preview deploys or custom domains need `QSTASH_WORKER_URL` set explicitly — see [`SCALING.md §4`](./docs/SCALING.md#4-integration-gotchas-lessons-from-shipping-phase-2) for the gotchas that will otherwise silently drop messages.

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

## Architecture at a glance

Next.js App Router on Vercel Fluid Compute, Supabase Postgres for durable state, Upstash Redis + QStash for rate-limit state and the crawl queue, Claude Haiku for LLM work. Three Supabase tables — `pages` (canonical per-URL result cache), `jobs` (one row per crawl execution), `user_requests` (signed-in history) — with Row-Level Security on all three.

The deeper picture — component diagram, crawl-request lifecycle, pipeline stages, threat model, performance ceilings — is in [`docs/`](./docs). Start with [`SYSTEM-DESIGN.md`](./docs/SYSTEM-DESIGN.md) for the visual overview, then [`DESIGN.md`](./docs/DESIGN.md) for the rationale.

## Further reading

- [`docs/DESIGN.md`](./docs/DESIGN.md) — pipeline rationale, crawl strategy, LLM prompt design, tradeoffs
- [`docs/SYSTEM-DESIGN.md`](./docs/SYSTEM-DESIGN.md) — Mermaid diagrams: component graph + crawl-request lifecycle
- [`docs/SECURITY.md`](./docs/SECURITY.md) — threat model and implemented controls
- [`docs/OBSERVABILITY.md`](./docs/OBSERVABILITY.md) — Sentry wiring, what's filtered, where to look when something breaks
- [`docs/SCALING.md`](./docs/SCALING.md) — phase-2 scaling plan: shipped work + what's next at each ceiling
- [`docs/PERFORMANCE.md`](./docs/PERFORMANCE.md) — honest throughput math across free / paid / enterprise tiers
- [`docs/TESTING.md`](./docs/TESTING.md) — manual test playbook covering golden paths and edge cases
