# llms.txt Generator — Local Setup (Phase 1)

## Quick start

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) (or the port shown in terminal if 3000 is in use).

## What Phase 1 includes

- Landing page with URL input
- Real async crawl pipeline (robots.txt → sitemap → BFS discovery)
- Page metadata extraction (title, meta description, og:description, JSON-LD, headings)
- .md variant probing (prefers markdown links per spec)
- Page classification (doc, api, example, blog, changelog, about, etc.)
- Site genre detection (developer_docs, ecommerce, personal_site, etc.)
- Priority-sorted crawl queue (docs/api/examples first)
- Deterministic scoring and section grouping
- Spec-compliant llms.txt assembly
- Spec validator
- Progress polling UI
- Editable result + copy + download

## No environment variables required for Phase 1

See `.env.example` — Phase 2 will add Supabase and Anthropic API keys.

## Architecture

- `app/` — Next.js App Router pages and API routes
- `lib/crawler/` — All crawler modules (types, url, robots, sitemap, fetchPage, extract, classify, genre, score, group, assemble, validate, pipeline)
- `lib/store.ts` — In-memory job store (globalThis-backed, survives hot reloads)
- `app/api/jobs/` — POST to create job, GET to poll status
