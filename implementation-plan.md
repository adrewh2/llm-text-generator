# llms.txt Generator — Phased Implementation Plan

## Goal

Build the project in phases so that Phase 1 delivers a **fully functional MVP that runs locally**, and later phases harden it for deployment, monitoring, and submission polish.

This plan is intentionally biased toward shipping a strong take-home project quickly. The first milestone should already be demoable end to end.

---

## Guiding implementation principles

- Ship the **deterministic core** before adding refinement and polish
- Keep the architecture **simple in Phase 1**; only add durable jobs, monitoring, and delivery paths once the generator works well locally
- Treat the design doc as the north star, but do not overbuild infrastructure before the core output quality is good
- Prefer **vertical slices** over isolated infrastructure work
- Make every phase end in something that is runnable and demoable

---

# Phase 1 — Local MVP (fully functional)

## Objective

Deliver a locally runnable web app that:

1. accepts a website URL,
2. crawls the site,
3. extracts metadata and key pages,
4. generates a spec-compliant `llms.txt`,
5. shows the result in the UI,
6. allows manual edits and download,
7. works across a reasonable variety of public websites.

This phase should be **fully functional locally** even if some later production features are not present yet.

## What Phase 1 includes

### Product surface

- Public landing page with URL input
- Generate action that starts a crawl
- Progress UI for crawl state
- Result page with generated `llms.txt`
- Editable output area
- Copy and download actions
- Validation badge for generated output
- Basic page explorer so the user can see which pages were included

### Backend behavior

- Deterministic crawl pipeline
- `robots.txt` fetch and parse
- Sitemap discovery and parsing
- Navigation-link discovery and BFS fallback
- URL normalization and deduplication
- Page metadata extraction:
  - title
  - meta description / og:description
  - headings
  - canonical URL
  - cleaned excerpt
- Markdown probing for `.md` variants
- Deterministic page classification and scoring
- Deterministic section grouping
- Deterministic final file assembly
- Graceful degradation when some pages fail

### Scope intentionally deferred to later phases

- Auth
- Preview/full split
- Persistent jobs
- Monitoring
- Webhook delivery
- Email delivery
- Override version history
- Browserless fallback for SPAs
- LLM refinement
- Hosted stable `/files/:id/llms.txt` URL

Those are all valuable, but they are **not required** to have a working MVP.

## Recommended local architecture for Phase 1

Keep this phase simple.

### Frontend

- Next.js App Router
- Tailwind CSS
- Single main route for generation
- Client polling against a local API route

### Backend

- Next.js API routes
- In-memory job store or local SQLite/Postgres for jobs during local development
- Direct async crawl execution in the API process or a lightweight internal job queue

### Storage

Two good options:

#### Option A — simplest
- in-memory jobs for progress
- no persistence across server restart

#### Option B — better for demos
- local Postgres or SQLite
- `jobs` and `pages` tables only

For a take-home, **local Postgres** is worth it if you can set it up quickly, because it keeps the later migration path cleaner.

## Phase 1 implementation tasks

### 1. Scaffold the app

- Initialize Next.js + TypeScript + Tailwind
- Add basic layout and landing page
- Add `.env.example`
- Add linting and formatting
- Add a minimal README section for local startup

### 2. Build the crawl pipeline as plain TypeScript services

Create small modules with clean responsibilities:

- `url.ts`
  - normalization
  - validation
  - internal/external link detection
- `robots.ts`
  - fetch robots
  - parse disallow rules
  - extract sitemap links
- `sitemap.ts`
  - fetch sitemap
  - parse sitemap index and urlset
- `discover.ts`
  - seed queue from sitemap and homepage
  - BFS fallback
- `fetchPage.ts`
  - fetch page HTML
  - content-type checks
  - size limit
- `markdownProbe.ts`
  - probe `.md` variants
- `extract.ts`
  - title, descriptions, headings, excerpt, canonical
- `classify.ts`
  - page type classification
- `score.ts`
  - base scoring + genre modifiers
- `group.ts`
  - section grouping
- `assemble.ts`
  - final markdown generation
- `validate.ts`
  - spec validation

### 3. Implement a local crawl job flow

- `POST /api/jobs`
  - accepts URL
  - creates job id
  - begins async crawl
- `GET /api/jobs/:id`
  - returns status
  - returns progress counts
  - returns result when complete

Use a simple local queue model first:

- create job record
- spawn async task
- update job status as phases complete

### 4. Build deterministic generation first

The MVP output quality should come from deterministic rules.

Implement:

- site name extraction
- description resolution
- section grouping
- Optional section behavior
- `.md` preference
- empty-section suppression

### 5. Build the result UI

- progress states: discovering, crawling, scoring, assembling, complete, failed
- code editor or textarea for result
- page explorer with included pages
- validation panel
- copy/download actions

### 6. Add quality-focused testing

At minimum for Phase 1:

- unit tests for normalization, scoring, grouping, assembly, validation
- integration tests against small fixture sites
- golden-file snapshot tests for generated `llms.txt`

### 7. Manual QA against real websites

Test at least:

- one developer docs site
- one e-commerce site
- one blog/publication site
- one simple personal site
- one institutional site

Capture failures and tune scoring heuristics.

## Phase 1 acceptance criteria

Phase 1 is done when all of the following are true:

- The app runs locally with one command or a short documented setup
- A user can enter a URL and get a generated `llms.txt`
- The output is valid against your built-in validator
- The result is editable and downloadable
- The crawler handles at least sitemap-based and nav-based sites
- The generator prefers `.md` links when available
- The system degrades gracefully on partial crawl failures
- At least 5 representative real sites have been tested manually
- The codebase is modular enough that monitoring/auth/LLM refinement can be added without rewriting the core

## Phase 1 demo story

By the end of this phase, you should be able to demonstrate:

1. enter URL,
2. show crawl progress,
3. inspect included pages,
4. show generated `llms.txt`,
5. make a small manual edit,
6. validate output,
7. download file.

That is already a credible take-home demo.

---

# Phase 2 — Persisted jobs, auth, and LLM refinement

## Objective

Upgrade the local MVP into a more product-like application with saved jobs, user ownership, and higher-quality summaries/descriptions.

## What Phase 2 adds

- Supabase Auth with Google/GitHub
- Persistent `jobs`, `pages`, and override snapshot tables
- Preview mode vs full mode
- Preview token flow
- Override saving and re-assembly
- LLM refinement pass:
  - site summary
  - gap-filling for missing descriptions
- Better error handling and partial-job UX

## Implementation tasks

### 1. Add persistent storage

Create the first real schema:

- `jobs`
- `pages`
- `preview_jobs`
- `preview_pages`
- `override_versions`

### 2. Add auth and ownership

- Supabase Auth integration
- RLS policies
- dashboard route for full jobs
- preview routes backed by preview token

### 3. Implement preview vs full modes

- unauthenticated preview flow
- authenticated full flow
- preview-to-full rerun path

### 4. Add LLM refinement

Keep it narrow:

- summary generation
- one-line descriptions for pages with no deterministic description
- batching and token cap
- graceful fallback when LLM call fails

### 5. Add override application

- exclude page
- custom description
- rename section
- reorder sections
- custom intro
- re-assemble without recrawling

## Phase 2 acceptance criteria

- Users can sign in and see saved jobs
- Preview and full jobs are clearly separated
- Overrides persist and re-assemble correctly
- LLM refinement improves output without changing structural decisions
- The app remains fully runnable locally using real storage and auth

---

# Phase 3 — Monitoring and update delivery

## Objective

Implement the “automated updates” requirement so the project fully satisfies the assignment beyond one-time generation.

## What Phase 3 adds

- `monitors` and `monitor_runs`
- incremental change detection
- periodic full reconciliation
- update delivery via stable URL
- webhook delivery
- email notifications
- delivery attempt tracking

## Implementation tasks

### 1. Add monitor schema

- `monitors`
- `monitor_runs`
- `delivery_attempts`

### 2. Implement monitoring workflow

- lightweight HEAD checks
- probe-hash fallback
- targeted recrawl
- periodic full reconciliation
- override reapplication
- diff calculation

### 3. Add public stable file route

- `GET /files/:monitor_id/llms.txt`
- correct content headers
- optional ETag

### 4. Add delivery paths

#### Stable URL
- public file endpoint
- UI instructions for proxy/rewrite setup

#### Webhook
- signed delivery
- retry behavior
- delivery attempt logging

#### Email
- change summary + download link

### 5. Add monitor UI

- create monitor form
- monitor detail page
- run history
- stale override warnings
- delivery status

## Phase 3 acceptance criteria

- A saved job can be turned into a monitor
- Monitors detect actual content/structure changes
- The file is regenerated when needed
- Stable URL serves the current file
- Webhook and/or email delivery works locally in test mode
- Monitor history and delivery outcomes are visible in UI

---

# Phase 4 — Production hardening and deployment

## Objective

Make the app robust enough for public review and submission.

## What Phase 4 adds

- Vercel deployment
- Inngest integration for durable jobs and cron
- Browserless fallback for SPAs
- observability
- rate limiting and security hardening
- better fixtures and broader QA

## Implementation tasks

### 1. Move long-running flows to Inngest

- crawl jobs
- preview cleanup
- monitor scheduling
- monitor execution

### 2. Add Browserless fallback

- SPA detection
- rendered fetch fallback
- usage tracking

### 3. Add security hardening

- SSRF protections
- redirect/IP validation
- content-type enforcement by fetch type
- response-size limits
- target-domain token bucket / queue
- secrets redaction in logs

### 4. Add observability

- job status metrics
- crawl durations
- pages discovered vs crawled
- LLM usage
- monitor update rate
- delivery success rate

### 5. Expand automated tests

- robots and crawl-delay tests
- webhook signature tests
- snapshot coverage for more genres
- failure-path tests

## Phase 4 acceptance criteria

- App is deployed and usable remotely
- Long-running jobs are durable and retryable
- Security-sensitive paths are implemented and tested
- The app handles common SPA/doc/blog/e-commerce variations better than the local MVP

---

# Phase 5 — Submission polish

## Objective

Package the project so it performs well in evaluation.

## What Phase 5 includes

- README
- screenshots and/or demo video
- seeded demo URLs
- architecture notes and trade-offs
- GitHub repo polish

## Implementation tasks

### README

Include:

- project overview
- architecture summary
- local setup
- environment variables
- database setup and migrations
- how to run the app
- how to run tests
- deployment instructions
- trade-offs and future work

### Demo assets

- screenshots of landing page, progress view, result view, monitor detail
- short demo video or GIF walkthrough

### Repo polish

- clean commit history if practical
- `.env.example`
- migration scripts
- seeded fixture sites or example URLs
- known limitations section

## Phase 5 acceptance criteria

- Repo is easy to clone and run
- README is complete and honest
- Demo materials clearly show the product working
- The project tells a coherent story from architecture to UX to monitoring

---

# Recommended build order inside Phase 1

If you want the fastest path to a real MVP, build in this order:

1. landing page + API contract
2. URL validation + normalization
3. page fetch + metadata extraction
4. sitemap parsing + homepage link discovery
5. BFS fallback
6. scoring + grouping
7. assembly + validation
8. progress tracking
9. result UI + download
10. tests + real-site QA

That order gets you to a usable generator as quickly as possible.

---

# Suggested milestone schedule

## Milestone 1

Scaffold app and generate from a single page.

**Output:** enter URL, fetch homepage, generate minimal `llms.txt`.

## Milestone 2

Add discovery, scoring, grouping, and validation.

**Output:** real multi-page deterministic generator running locally.

## Milestone 3

Add persistence, auth, preview/full split, overrides, and LLM refinement.

**Output:** real product experience locally.

## Milestone 4

Add monitoring and stable delivery path.

**Output:** assignment fully satisfied from a feature perspective.

## Milestone 5

Deploy, polish, document, and record demo.

**Output:** submission-ready project.

---

# Final recommendation

Treat **Phase 1 as the success-critical phase**.

If Phase 1 is excellent, you already have a strong take-home. Everything after that should make the project more complete, more polished, and easier to defend, but it should not require rewriting the core.
