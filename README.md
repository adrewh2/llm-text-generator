# llms.txt Generator

A web app that crawls any website and produces a spec-compliant [`llms.txt`](https://llmstxt.org) file describing its most important pages for LLM consumption.

Paste a URL, the app discovers pages (sitemap → robots → link-following, with a Puppeteer fallback for SPAs), extracts metadata, uses an LLM to classify each page and write a concise description, scores and groups the pages into sections, and assembles the final `llms.txt`.

## Features

**Crawler**
- Discovery via `sitemap.xml`, `robots.txt`, and BFS link traversal (respects `Disallow` rules)
- Markdown-variant probing (prefers `.md` links per the spec)
- SPA detection + headless-Chrome fallback via `puppeteer` (local) / `@sparticuz/chromium` (Vercel)
- Worker-pool concurrency with politeness delay

**LLM enrichment**
- Per-page classification (`doc`, `api`, `example`, `blog`, `changelog`, `about`, …) via Claude
- LLM-written descriptions, section names, and scoring — tuned to the site's inferred genre
- Site-genre detection (`developer_docs`, `ecommerce`, `personal_site`, …) adapts section naming

**Output**
- Spec-compliant `llms.txt` assembly with generated preamble and importance-ordered sections
- In-browser validator + editable result + copy / download

**Accounts + shared cache**
- Supabase magic-link auth
- Globally-shared page cache: one canonical result per URL, reused across users
- 24-hour TTL — stale pages trigger a fresh crawl; old result is preserved until the new one succeeds
- Per-user dashboard of every page you've generated; remove-from-history action
- Row-Level Security on every table; service-role key used only server-side

## Running locally

```bash
npm install
cp .env.example .env   # fill in the values — see below
npm run dev
```

Open <http://localhost:3000>.

### Environment variables

| Variable | Where | Purpose |
|---|---|---|
| `ANTHROPIC_API_KEY` | server | Claude API for page enrichment |
| `SUPABASE_URL` | server | Supabase project URL |
| `SUPABASE_ANON_KEY` | server | Supabase anon key (used for auth helpers) |
| `SUPABASE_SERVICE_ROLE_KEY` | server | Bypasses RLS for store writes — **never expose to the client** |
| `NEXT_PUBLIC_SUPABASE_URL` | browser | Same URL, exposed for the browser Supabase client |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | browser | Anon key exposed to the browser |

### Supabase setup

The full schema (tables, RLS, policies) is in [`supabase/migration.sql`](./supabase/migration.sql). Run it once against a fresh Supabase project.

## Architecture

```
app/
  page.tsx               Landing page / URL input
  p/[id]/page.tsx        Result + simulated-progress view
  dashboard/             Per-user page history
  login/                 Magic-link auth
  api/p/                 POST create | GET status | DELETE from history
  auth/callback          Supabase auth callback

lib/crawler/
  pipeline.ts            Orchestrates crawl → enrich → score → assemble
  discover.ts            Sitemap + robots + BFS URL discovery
  fetchPage.ts           HTTP fetch with markdown-variant probing
  spaCrawler.ts          Puppeteer fallback for JS-rendered sites
  extract.ts             Cheerio-based metadata extraction
  llmEnrich.ts           Claude-powered classification + descriptions
  score.ts, group.ts     Importance scoring + section grouping
  assemble.ts            Final llms.txt string assembly
  validate.ts            Spec validator

lib/store.ts             Supabase-backed page + job + user-request store
lib/supabase/            Browser + SSR client factories
middleware.ts            Supabase auth cookie refresh
supabase/migration.sql   Schema + RLS policies
```

### Data model

- **`pages`** — one row per URL (globally shared cache). `result` holds the generated `llms.txt`.
- **`jobs`** — one row per crawl execution, FK → `pages.url`. Multiple jobs can exist per page (e.g. TTL refreshes).
- **`user_requests`** — tracks which pages a signed-in user has generated; powers the dashboard.

### Security

RLS is enabled on every table. All app traffic to Supabase goes through server-only code using the **service-role key**, which bypasses RLS. The policies below define what *would* happen if someone queried Supabase directly with the anon key:

- `pages` / `jobs`: public read (these results are the product)
- `user_requests`: `auth.uid() = user_id` — one user cannot read another user's history even with the anon key
