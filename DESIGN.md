# llms.txt Generator — Final System Design

## 1. Overview

A web application that crawls any public website, structures its content into a spec-compliant `llms.txt` file, and keeps that file current as the site evolves. Users can generate a file instantly in preview mode, then sign in to save it, customize it, and enable automated monitoring.

### Product goals

- Generate a useful, spec-compliant `llms.txt`, not a sitemap dump
- Work across a wide variety of sites: developer docs, e-commerce, personal, institutional, and publication/blog sites
- Keep structural decisions deterministic and explainable
- Preserve user edits across re-runs
- Provide a real path to serving the updated file at the user's own `/llms.txt`
- Treat arbitrary URL crawling as a security-sensitive operation from day one

### Core design principles

1. **Deterministic first, LLM as refinement.** Discovery, normalization, page scoring, section grouping, inclusion, and optionality are all deterministic. The LLM writes the short intro summary and fills description gaps only.
2. **Markdown preference.** The crawler probes for `.md` variants and prefers them in generated links when they exist, in line with the `llms.txt` proposal.
3. **Curated, not exhaustive.** The output is a ranked subset of the site, tuned by detected site genre.
4. **User customization survives regeneration.** Saved edits are re-applied after every monitor-triggered re-run.
5. **Preview before signup.** Users can see real output before authenticating. Saved jobs, monitoring, and durable customization require auth.
6. **Security is part of the architecture.** SSRF protection, rate limiting, redirect validation, and request signing are core design elements.

---

## 2. Scope and Non-Goals

### In scope

- Public websites reachable over HTTP(S)
- Spec-compliant `llms.txt` generation
- Preview mode and full authenticated mode
- Monitoring with incremental checks and periodic full reconciliation
- User overrides and rollback
- Hosted stable file URL plus deployment/update paths

### Out of scope for MVP

- Authenticated crawling behind login walls
- JavaScript-heavy sites that require complex user interaction before content appears
- Full repository write-back automation such as GitHub PR creation
- Multi-tenant organization workspaces

---

## 3. Spec Alignment

The output follows the structure defined at [llmstxt.org](https://llmstxt.org/):

- A required H1 with the project or site name (the only required element per spec)
- A blockquote with a short summary containing key information for understanding the rest of the file
- Zero or more preamble paragraphs or lists, with no headings of any level permitted in this section
- Zero or more H2-delimited sections containing file lists
- Each file list entry is a markdown hyperlink `[name](url)`, optionally followed by `: ` and a short description
- An `## Optional` section only when secondary entries exist that can be skipped in shorter contexts

Links prefer `.md` variants when available. Empty sections are never rendered. The `## Optional` section is semantically meaningful per the spec and is included only when there is genuinely secondary material worth deferring.

### Graceful degradation

If the LLM call fails or is unavailable, the generator still produces a valid file. The H1, which is always deterministic, is the only required element. The blockquote summary is omitted rather than fabricated, and pages without extractable descriptions are listed without the optional `: description` suffix. Both are spec-valid outputs.

### Example generated output

For a developer documentation site:

```markdown
# FastHTML

> FastHTML is a Python library that combines Starlette, Uvicorn, HTMX, and fastcore's FastTags into a framework for building server-rendered hypermedia applications.

FastHTML is not compatible with FastAPI syntax and does not target API services. It works with JS-native web components and vanilla JS libraries, but not with React, Vue, or Svelte.

## Docs

- [Quick start for web devs](https://fastht.ml/docs/tutorials/quickstart_for_web_devs.html.md): A brief overview of many FastHTML features covering routing, templates, and HTMX integration
- [HTMX reference](https://github.com/bigskysoftware/htmx/blob/master/www/content/reference.md): All HTMX attributes, CSS classes, headers, events, extensions, and config options

## Examples

- [Todo list application](https://github.com/AnswerDotAI/fasthtml/blob/main/examples/adv_app.py): Complete CRUD app walkthrough showing idiomatic FastHTML and HTMX patterns

## Optional

- [Starlette documentation](https://gist.githubusercontent.com/jph00/809e4a4808d4510be0e3dc9565e9cbd3/raw/starlette-sml.md): Subset of Starlette docs relevant to FastHTML development
```

For an e-commerce site:

```markdown
# Acme Store

> Acme Store sells outdoor camping and hiking gear with free shipping on orders over $50 and a 30-day return policy.

## Products

- [Tents & Shelters](https://acme.example.com/collections/tents): Full range of 1-person to 6-person tents for backpacking and car camping
- [Hiking Footwear](https://acme.example.com/collections/footwear): Trail runners, hiking boots, and approach shoes

## Support

- [Shipping & Returns](https://acme.example.com/policies/shipping-returns): Shipping rates, delivery times, and return instructions
- [Size Guide](https://acme.example.com/pages/size-guide): Measurement charts for apparel and footwear

## Optional

- [The Trail Journal](https://acme.example.com/blog): Gear reviews, trip reports, and seasonal buying guides
```

---

## 4. User Modes

### 4.1 Preview mode (unauthenticated)

Preview mode is designed to remove signup friction while still supporting async crawling and progress polling.

#### Behavior

- No sign-in required
- Limited crawl budget: max 25 pages, max depth 2
- Result can be viewed, copied, and downloaded
- No monitoring
- No durable dashboard entry
- No saved override history
- Preview data expires automatically after 24 hours

#### Important clarification

Preview jobs are **ephemerally persisted**, not durably saved. This supports async job execution, progress polling, and download, but preview jobs are not attached to a user account and are automatically deleted after TTL expiry. Cleanup runs via a scheduled Inngest function every hour that deletes `preview_jobs` rows, and cascaded `preview_pages` rows, where `expires_at < now()`.

### 4.2 Full mode (authenticated)

Full mode unlocks persistent product features.

#### Behavior

- Sign in with Google or GitHub via Supabase Auth
- Configurable crawl budget and depth
- Saved jobs in dashboard
- Persistent overrides and version history
- Monitoring and deployment update paths
- Access control enforced by JWT and RLS

### 4.3 Preview-to-full conversion

When an unauthenticated user signs in after generating a preview, the system re-runs the crawl as a full job with the expanded budget rather than attempting to migrate preview data. This avoids ownership migration complexity, ensures the full job has complete crawl coverage, and gives the user an immediately better result. The UI pre-fills the same URL and offers a one-click `Run full crawl` action.

---

## 5. Tech Stack

| Layer | Choice | Rationale |
|---|---|---|
| Framework | Next.js 15 (App Router) | Single repo for UI + API routes |
| Language | TypeScript | Type safety across crawler, API, and UI |
| Auth | Supabase Auth | OAuth + JWT issuance + simple integration |
| Database | Supabase Postgres | Durable storage for full jobs, pages, monitors, override versions |
| Ephemeral preview store | Supabase Postgres `preview_jobs` with TTL cleanup | Reuses existing infra while keeping preview isolated from user-owned data |
| Background jobs | Inngest | Durable step functions, retries, fan-out, cron |
| Static crawling | `fetch` + `cheerio` | Fast path for most sites |
| JS rendering fallback | Browserless.io API | SPA fallback without bundling Chromium |
| AI refinement | Anthropic Claude | Intro summary + description gap-filling only |
| Styling | Tailwind CSS + shadcn/ui | Fast, consistent UI primitives |
| Deployment | Vercel | Straightforward Next.js deployment |

### Why Inngest

Crawling and monitoring are long-running, retry-heavy workflows with fan-out. Inngest gives durable steps, partial retry, and cron without adding Redis plus a worker fleet. It also provides the scheduled function primitive used for preview TTL cleanup and monitor scheduling.

---

## 6. High-Level Architecture

```text
Browser
  │
  │ POST /api/jobs { url, options, preview?: true }
  ▼
Next.js API Routes
  │
  │ validate URL + SSRF checks
  │ preview? create preview token + TTL-backed preview job
  │ full? require JWT and create durable job
  │ enqueue Inngest event
  ▼
Inngest Workflow
  ├── fetchRobotsTxt
  ├── fetchSitemaps
  ├── detectSiteGenre
  ├── normalizeAndSeedQueue
  ├── crawlPages (fan-out, per-domain throttling)
  │     ├── metadata HEAD
  │     ├── .md probe (HEAD, then lightweight GET fallback)
  │     ├── static fetch + extraction
  │     └── Browserless fallback when needed
  ├── scorePages
  ├── groupSections
  ├── refineWithLLM (summary + missing descriptions only)
  ├── applyOverrides (full mode only)
  └── assembleFile + validate
  │
  ├── write to preview_jobs OR jobs/pages tables
  ▼
Browser polls GET /api/jobs/:id
  │
  ├── preview: requires preview token
  └── full: requires owner JWT
  ▼
Result view
  ├── copy/download
  ├── full mode: save overrides, enable monitor
  ▼
Monitoring workflow
  ├── Phase 1: HEAD / lightweight probe
  ├── Phase 2: targeted re-crawl on change
  ├── periodic full reconciliation
  ├── LLM refinement for changed gaps / changed homepage summary
  ├── apply current override version
  └── deliver update via stable URL, webhook, or email
```

---

## 7. Security Model

Arbitrary URL fetching is a core attack surface. The design assumes hostile input.

### 7.1 SSRF protection

Every URL is validated before any network request. Candidate page fetches, markdown probes, sitemap fetches, and `robots.txt` fetches are all subject to IP and redirect validation. Content-type rules vary by fetch purpose.

1. Only `http://` and `https://`
2. DNS resolution before request
3. Block IPv4 private, loopback, link-local, multicast, unspecified, and metadata ranges
4. Block IPv6 loopback, unique-local, link-local, and unspecified ranges
5. Re-resolve and re-validate on every redirect hop to mitigate DNS rebinding
6. Max 5 redirects
7. 10 second hard timeout per request
8. Content-type policy by fetch purpose:
   - Candidate page fetches: `text/html`, `application/xhtml+xml`
   - Markdown probes: `text/markdown`, `text/x-markdown`, or `text/plain` with markdown signals
   - Sitemaps and discovery documents: `application/xml`, `text/xml`, and other sitemap-compatible XML responses
   - `robots.txt`: `text/plain`
9. Response size enforcement: check `Content-Length` header first and reject if over 5 MB; if `Content-Length` is absent, stream with a byte counter and abort at 5 MB
10. Never forward internal credentials or cookies to target sites
11. Global target-domain protection: use a configurable token bucket or queue per target domain across all users to prevent the service from being used as a crawl amplifier

### 7.2 Rate limiting

Rate limiting applies at two levels: protecting our own infrastructure and being polite to target sites.

#### Our API

- Preview: 3 crawl jobs per IP per hour
- Authenticated: 5 concurrent jobs, 20 jobs per day, 3 active monitors per account

#### Target site politeness

- Per-domain concurrency limit: max 2 concurrent requests to any single domain
- Base delay between requests to the same domain: 500ms with +/-200ms random jitter
- Honor `Crawl-delay` from `robots.txt` when present, capped at 30 seconds; if the declared delay exceeds 30 seconds, preview mode fails the job with a clear message explaining the site requests slower crawling than preview supports, and full mode proceeds at the 30 second cap with a warning shown in results
- Adaptive backoff: on HTTP 429 or 503 with `Retry-After`, respect the header up to 60 seconds, then resume; after 3 consecutive throttle responses, pause crawl of that domain for 5 minutes
- Per job: max 8 concurrent page fetches total across all domains

### 7.3 Crawler identity

All requests include:

- `User-Agent: LlmsTxtGenerator/1.0 (+https://app.domain.com/about/crawler)` with a URL explaining the bot's purpose
- The crawler obeys directives matching its own user-agent string first, then falls back to `*` directives in `robots.txt`

### 7.4 Webhook security

Webhook delivery is signed.

#### Secret ownership model

If a user enables webhook delivery, the system generates a random webhook signing secret, shows it exactly once at monitor creation time, and stores it encrypted at rest. The system uses that secret to sign future outbound webhook deliveries. The secret is never returned again by read APIs.

#### Storage model

- Raw secret: generated by the application at monitor creation
- Stored value: encrypted at rest using application-level envelope encryption with a server-side master key from environment configuration
- Read behavior: never returned by monitor read APIs
- Rotation: generate a new secret, surface it once, switch future deliveries to the new secret, then invalidate the old one after a short propagation window

#### Headers

- `X-LLMS-Signature`: HMAC-SHA256 signature
- `X-LLMS-Timestamp`: Unix timestamp
- `X-LLMS-Delivery-Id`: unique idempotency key

#### Behavior

- Recipients verify timestamp freshness and HMAC
- Up to 3 retries with exponential backoff on 5xx and timeouts
- No retries on 2xx or explicit 4xx

### 7.5 Token and secret redaction

- `X-Preview-Token` values are never written to logs, analytics, or error reporting
- JWTs, webhook secrets, and signature material are redacted from structured logs
- Delivery payload logs store metadata only, not secret-bearing headers

---

## 8. API Design

| Method | Path | Access | Description |
|---|---|---|---|
| POST | `/api/jobs` | Optional auth | Start preview or full crawl. Returns `{ job_id, preview_token? }`. |
| GET | `/api/jobs/:id` | Owner JWT or preview token | Poll status and fetch result. |
| PATCH | `/api/jobs/:id/overrides` | Owner JWT | Save overrides and re-assemble from stored crawl data only. |
| POST | `/api/monitors` | Owner JWT | Create monitor. |
| GET | `/api/monitors/:id` | Owner JWT | Get monitor config and recent runs. |
| GET | `/api/monitors/:id/history` | Owner JWT | Paginated monitor run history. |
| DELETE | `/api/monitors/:id` | Owner JWT | Disable or delete monitor. |
| GET | `/files/:monitor_id/llms.txt` | Public | Stable hosted file URL. |

### Preview access semantics

Preview jobs are not readable by bare job id alone. `POST /api/jobs` returns an opaque `preview_token`. The client sends that token via an `X-Preview-Token` header on subsequent `GET /api/jobs/:id` requests. This avoids collision with the `Authorization` header used for JWT-authenticated requests. The server stores only a SHA-256 hash of the token.

### Public file endpoint behavior

`GET /files/:monitor_id/llms.txt` returns:

- `Content-Type: text/plain; charset=utf-8`
- `Cache-Control: no-cache, must-revalidate`
- optional `ETag` for downstream cache validation

### Override endpoint clarification

`PATCH /api/jobs/:id/overrides` does **not** crawl again and does **not** call the LLM. It re-assembles the file from persisted crawl artifacts and the new override snapshot.

---

## 9. Data Model

### 9.1 Full job tables

#### `jobs`

| Column | Description |
|---|---|
| `result` | The final assembled `llms.txt` output with overrides applied, if any. This is what the user sees and downloads. |
| `result_raw` | The pre-override output from the deterministic pipeline plus LLM refinement. Preserved so that overrides can be re-applied against the original crawl output without re-running the pipeline. |

```sql
id                    uuid primary key
user_id               uuid references auth.users not null
url                   text not null
status                text not null  -- pending | crawling | scoring | refining | complete | failed | partial
genre                 text not null
result                text           -- final output with overrides applied
result_raw            text           -- pre-override pipeline output
crawl_options         jsonb
current_override_version_id uuid null
error_summary         text null      -- human-readable summary when status = failed or partial
created_at            timestamptz
updated_at            timestamptz
```

#### `pages`

```sql
id                    uuid primary key
job_id                uuid references jobs not null
url                   text not null
md_url                text null
title                 text null
description           text null
body_excerpt          text null
headings              jsonb
json_ld               jsonb
lang                  text null
etag                  text null
last_modified         text null
content_hash          text null   -- SHA-256 of normalized extracted text after full extraction
probe_hash            text null   -- SHA-256 of lightweight probe content for monitor phase 1 fallback
page_type             text not null
score                 int not null
section               text null
is_optional           boolean default false
description_provenance text not null  -- json_ld | og | meta | excerpt | heading | llm | none
fetch_status          text not null default 'ok'  -- ok | timeout | error | skipped
crawled_at            timestamptz
```

#### `monitors`

The `url` column is denormalized from the parent job for query convenience and avoids joining `jobs` on every monitor scheduling query.

```sql
id                    uuid primary key
job_id                uuid references jobs not null
user_id               uuid references auth.users not null
url                   text not null    -- denormalized from jobs.url
frequency             text not null    -- daily | weekly | monthly
notification_email    text null
webhook_url           text null
webhook_secret_encrypted text null     -- encrypted webhook signing secret, never returned by read APIs
last_checked_at       timestamptz null
next_check_at         timestamptz null
last_full_reconcile   timestamptz null
reconcile_cycle_count int default 0
enabled               boolean default true
created_at            timestamptz
```

#### `monitor_runs`

`monitor_runs.status` describes the crawl and regeneration outcome only. Delivery success or failure is tracked separately in `delivery_attempts`, so a run may be `updated` even if webhook or email delivery later fails.

```sql
id                    uuid primary key
monitor_id            uuid references monitors not null
status                text not null     -- no_change | updated | error
check_method          text not null     -- lightweight | targeted_recrawl | full_reconciliation
changes               jsonb
new_result            text null
ran_at                timestamptz
duration_ms           int
```

#### `delivery_attempts`

Tracks per-channel delivery outcomes for webhook and email. Kept separate from `monitor_runs` to support per-channel retry without duplicating run data.

```sql
id                    uuid primary key
monitor_run_id        uuid references monitor_runs not null
channel               text not null     -- webhook | email
status                text not null     -- success | failure
attempt_number        int not null
response_code         int null          -- HTTP status for webhooks
error_message         text null
delivery_id           text null         -- matches X-LLMS-Delivery-Id for webhooks
attempted_at          timestamptz
```

### 9.2 Preview job tables

#### `preview_jobs`

```sql
id                    uuid primary key
url                   text not null
status                text not null  -- pending | crawling | scoring | refining | complete | failed | partial
preview_token_hash    text not null  -- SHA-256 of opaque preview token
result                text null      -- final assembled output, no overrides in preview
result_raw            text null      -- same as result in preview mode, no override layer
expires_at            timestamptz not null
created_at            timestamptz
updated_at            timestamptz
```

#### `preview_pages`

Same shape as `pages`, but keyed to `preview_jobs` and cascade-deleted with the preview job.

### 9.3 Override versioning

#### `override_versions`

Each save is an immutable full snapshot.

```sql
id                    uuid primary key
job_id                uuid references jobs not null
user_id               uuid references auth.users not null
version               int not null
snapshot              jsonb not null  -- full override payload
created_at            timestamptz
```

#### `override_stale_refs`

```sql
id                    uuid primary key
override_version_id   uuid references override_versions not null
reason                text not null   -- page_moved | page_removed
stale_url             text not null
replacement_url       text null
detected_at           timestamptz
```

#### Override snapshot structure

```json
{
  "excluded_urls": [],
  "custom_descriptions": {"url": "description"},
  "section_renames": {"Docs": "Documentation"},
  "section_order": ["Docs", "API", "Examples"],
  "pinned_urls": {"https://example.com/x": "API"},
  "custom_intro": "...",
  "custom_notes": ["..."]
}
```

Rollback is implemented by marking an older override version as current on the job.

---

## 10. Crawl Workflow

### 10.1 Discovery order

1. `robots.txt` — parsed for the `LlmsTxtGenerator` user-agent first, then `*` as fallback
2. `sitemap.xml` and sitemap indexes
3. Homepage and navigation links
4. BFS crawl fallback

Disallowed URLs are never fetched. `Crawl-delay` is honored as described in section 7.2.

### 10.2 Site genre detection

Genre is detected once from homepage and site-wide signals.

#### Signals

- Homepage metadata
- JSON-LD types
- Nav labels
- Sitemap and path patterns
- Common commerce, docs, and publication keywords

#### Supported genres

- `developer_docs`
- `ecommerce`
- `personal_site`
- `institutional`
- `blog_publication`
- `generic`

If confidence is low, fallback is `generic`.

### 10.3 URL normalization

- Lowercase scheme and hostname
- Strip tracking params such as `utm_*`, `fbclid`, and `gclid`
- Strip known session params
- Strip fragments
- Normalize trailing slash policy per observed site convention
- Collapse duplicate slashes
- Safe percent-decoding
- Drop print and export views
- Drop archive and tag listing pages, while keeping individual posts
- Deduplicate by canonical URL when present
- Locale handling governed by explicit locale policy in section 10.4

### 10.4 Locale policy

Locale handling is not hardcoded to English.

#### Default behavior

- Prefer `x-default` when declared
- Else prefer canonical locale
- Else keep variants separate

#### User options

- Crawl all locales
- Target specific locale

Dropped locale variants are logged in the UI.

### 10.5 Markdown probing

For every candidate URL:

1. Probe `.md` equivalent with HEAD, trying `{url}.md` and, for URLs ending in `/`, `{url}index.html.md` per the spec
2. If HEAD is unsupported or inconclusive, do lightweight GET fallback using the first 4 KB
3. Validate content type (`text/markdown`, `text/x-markdown`, or `text/plain` with markdown signals) and check for basic markdown structure
4. Prefer `md_url` in generated file when found

### 10.6 Per-page extraction

Extraction uses a combination of sources, not URL patterns alone.

#### Sources

- URL path
- Nav label or anchor text where discovered
- Page title
- meta description and og description
- Headings
- JSON-LD
- Cleaned body excerpt, first ~2000 chars of main content with boilerplate stripped
- Canonical URL
- `lang`
- Response headers

#### SPA fallback

Use Browserless only when:

- Static extraction is sparse (title-only or empty body), and
- The document shows strong SPA signals such as React, Vue, or Angular bundles, or empty app shells

### 10.7 Error handling and partial completion

Individual page fetches can fail without failing the entire job.

#### Per-page failures

- Timeouts, 4xx, 5xx, or connection errors are recorded in `pages.fetch_status`
- Failed pages are excluded from scoring and output
- The page is still stored so monitoring can retry it later

#### Job-level failure policy

- If the homepage fails, the job is `failed`, since genre detection and site name extraction depend on it
- If the homepage succeeds but no additional usable pages are discovered, the job may still complete if the homepage alone yields enough information to assemble a meaningful file
- If more than 50% of candidate pages fail but the homepage succeeded, the job status is `partial` and the result is assembled from successful pages with a warning shown in the UI
- If fewer than 50% of pages fail, the job is `complete` and failed pages are noted in the page explorer

#### Inngest retry behavior

- Each Inngest step has its own retry policy, max 3 retries with backoff
- The `crawlPages` fan-out retries individual page fetches, not the entire fan-out
- If `refineWithLLM` fails after retries, the job completes without LLM refinement, per graceful degradation in section 3

---

## 11. Classification, Scoring, and Grouping

### 11.1 Page type classification

Page type is inferred from a weighted mix of path patterns, title and headings, nav text, and schema signals.

#### Common page types

- `doc`
- `api`
- `example`
- `blog`
- `changelog`
- `about`
- `product`
- `pricing`
- `support`
- `policy`
- `program`
- `news`
- `project`
- `other`

### 11.2 Base scoring

```text
+25 meaningful meta or og description
+20 markdown variant exists
+15 structured JSON-LD
+10 meaningful h1 distinct from site name
+10 substantial excerpt
-15 paginated URL
-20 print or export view
-25 archive or tag page
```

### 11.3 Genre modifiers

#### developer_docs

```text
+20 doc/api/example
-15 blog
-25 about
```

#### ecommerce

```text
+25 product/pricing
+15 support/policy
-20 changelog
```

#### personal_site

```text
+20 about/project/blog
+10 other
```

#### institutional

```text
+20 program/about
+15 support/policy
-15 changelog
```

#### blog_publication

```text
+20 blog
+10 about
+10 support/policy if prominent
```

#### generic

```text
no genre-specific adjustment
```

#### Calibration note

Score thresholds (30 for exclusion, 50 for primary inclusion) and point values above are starting points chosen based on manual testing against a set of reference sites. They will be tuned through broader testing during implementation. The scoring system is designed so that adjusting weights and thresholds is a configuration change, not a structural one.

### 11.4 Inclusion policy

- Max crawl pages configurable, default 150 in full mode
- Max output entries 60
- Score `< 30`: excluded
- Score `30-49`: candidate for `Optional`
- Score `>= 50`: candidate for primary sections
- User exclusions always win

#### Blog and publication volume handling

For `blog_publication` and `generic` sites with large numbers of blog posts, inclusion is further filtered. Blog-type pages that pass the score threshold are ranked by a composite of recency (publish date from JSON-LD, meta tags, or URL date patterns), navigation prominence (linked from homepage or main nav vs deep archive), and score. The top N posts are included (default 10, configurable), with the rest excluded. This prevents a 500-post blog from dominating the output.

### 11.5 Deterministic section grouping

#### developer_docs

- `doc` -> `Docs`
- `api` -> `API`
- `example` -> `Examples`
- `changelog` -> `Changelog`
- `blog` -> `Optional` if included
- `about` -> `Optional` if included

#### ecommerce

- `product` -> `Products`
- `pricing` -> `Pricing`
- `support` -> `Support`
- `policy` -> `Policies` when high-signal, else `Optional`
- `blog` -> `Optional` when included

#### personal_site

- `about` -> `About`
- `project` -> `Projects`
- `blog` -> `Writing`
- `other` -> nearest meaningful section by path or topic, or `Optional`

#### institutional

- `program` -> `Programs`
- `about` -> `About`
- `support` -> `Contact & Support`
- `policy` -> `Policies`
- `news` -> `Optional` when included

#### blog_publication

- `blog` -> `Articles`
- `about` -> `About`
- `support` -> `Resources`
- `policy` -> `Optional`

#### generic

- Group by strongest inferred page family
- Otherwise group by nearest path or topic cluster
- Fall back to `Resources`

#### Collapse rules

- Do not emit empty sections
- Do not emit one-link sections if they can be absorbed cleanly into an adjacent section
- Render `## Optional` only when optional entries exist

---

## 12. Deterministic Extraction Rules

### 12.1 Site name extraction

Priority order:

1. `og:site_name`
2. `application-name`
3. JSON-LD `Organization` or `WebSite.name`
4. Normalized homepage title, stripping trailing ` - Home`, ` | Homepage`, and similar suffixes
5. Homepage h1
6. Hostname heuristic: capitalize and strip `www.`

### 12.2 Description resolution

Priority order per page:

1. JSON-LD description
2. og:description
3. meta description
4. First sentence of cleaned excerpt
5. Heading-derived fallback (first meaningful h2)
6. `none`: no description emitted, page listed as `[title](url)` without `: description`

`description_provenance` stores which source won.

---

## 13. LLM Refinement

The model is used narrowly and only after deterministic steps complete.

### 13.1 Inputs

- Site URL
- Detected genre
- Site name
- Homepage excerpt, first ~2000 chars with boilerplate stripped
- Pages with `description_provenance = none`

For each page needing a description:

- URL
- Title
- Headings (first 10)
- Body excerpt (first ~1000 chars)
- Assigned section

### 13.2 Tasks

1. Write a 1-2 sentence blockquote summary for the site
2. Write one-sentence descriptions only for pages missing descriptions
3. Return structured JSON

### 13.3 What the LLM does not decide

- Site name
- Scoring
- Inclusion
- Optionality
- Section assignment

### 13.4 Token budget and batching

A single refinement call includes the site context (about 500 tokens) plus per-page context (about 150 tokens each). If the number of description-less pages exceeds 30, pages are batched into groups of 30 with the site context repeated in each batch. Total token budget per job is capped at about 20K input tokens. Pages beyond this cap are listed without descriptions rather than queued for additional LLM calls.

### 13.5 Monitoring interaction

LLM refinement also runs during monitoring **only when needed**:

- If changed or new pages have no extractable description
- If the homepage content or site-level summary signals materially changed, detected via `content_hash` change on the homepage

Otherwise monitoring re-uses prior deterministic content and skips the LLM call.

---

## 14. User Overrides

### 14.1 Override application order

Overrides are applied to the deterministic plus LLM output in this order:

1. Remove excluded URLs
2. Replace descriptions
3. Rename sections
4. Reorder sections
5. Pin or move pages to sections
6. Replace intro summary if custom intro exists
7. Append custom notes

### 14.2 Merge policy on re-runs

#### Page moved

- Detect via canonical change or redirect
- Mark old override reference stale
- Do not silently map it to the new URL
- Surface replacement candidate in UI

#### Page removed

- Mark stale and show warning
- Keep old override in history

#### New page added

- Include via normal scoring and grouping
- Show `new since last edit` badge

#### Rollback

- Users can restore any of the last 5 override versions
- Restoring creates a new current version referencing the chosen snapshot

---

## 15. Monitoring System

### 15.1 Setup

Users can enable monitoring for a full-mode job with:

- Frequency: daily, weekly, or monthly
- Notification email
- Optional webhook URL
- Optional generated webhook signing secret, shown once at creation and stored encrypted at rest

A stable hosted file is always provisioned at `/files/{monitor_id}/llms.txt`.

### 15.2 Phase 1: lightweight checks

For each tracked page:

1. HEAD request
2. Compare ETag when available
3. Compare Last-Modified when available
4. Compare sitemap `lastmod` when available
5. If HEAD is unreliable (no ETag or Last-Modified, or server returns 200 for everything), do lightweight GET and compare **probe hash** to stored `probe_hash`

If nothing changed, record `no_change` and stop.

### 15.3 Phase 2: targeted re-crawl

If any page changed, was added, or disappeared:

- Fully re-fetch only impacted pages
- Recompute `content_hash` and `probe_hash`
- Re-score and re-group affected inclusion set
- Run LLM refinement only if needed (see section 13.5)
- Apply current override version
- Assemble new file
- Compute diff and store monitor run

### 15.4 Periodic full reconciliation

Every 7 monitor cycles:

- Re-fetch `robots.txt`
- Re-fetch sitemaps and sitemap indexes
- Rediscover candidate URLs via homepage and navigation crawl
- Detect removed and newly eligible pages
- Rebuild inclusion set from scratch
- Re-run grouping and refinement as needed

This catches structural drift that page-level checks miss.

---

## 16. Real Update Delivery Paths

### 16.1 Option A: reverse proxy or rewrite (preferred)

Preferred because the file is served from the user's own `/llms.txt` path with a 200 response.

#### Nginx example

```nginx
location = /llms.txt {
    proxy_pass https://app.domain.com/files/{monitor_id}/llms.txt;
    proxy_set_header Host app.domain.com;
    add_header Content-Type text/plain;
}
```

#### Next.js rewrite example

```js
rewrites: async () => [{
  source: '/llms.txt',
  destination: 'https://app.domain.com/files/{monitor_id}/llms.txt',
}]
```

### 16.2 Option B: webhook push

On change, send signed JSON payload:

```json
{
  "url": "https://their-site.com",
  "updated_at": "2026-04-17T03:02:00Z",
  "content": "# Site Name\n\n> ...",
  "changes": {
    "added": [],
    "removed": [],
    "modified": []
  },
  "delivery_id": "uuid"
}
```

### 16.3 Option C: email notification

Diff summary plus download link. Manual redeployment fallback.

### 16.4 Future option

GitHub PR creation can be added later for review-before-publish flows.

---

## 17. Frontend Design

### 17.1 Routes

- `/` — landing + preview generation
- `/dashboard` — saved jobs + monitors
- `/jobs/[id]` — full job detail
- `/preview/[id]` — preview result page, backed by preview token
- `/monitors/[id]` — monitor detail
- `/files/[id]/llms.txt` — public hosted file

### 17.2 Landing page

- URL input with prominent CTA
- Immediate preview mode on submit
- Example output showing a real generated file
- Lightweight explanation of monitoring and deploy paths

### 17.3 Result view

#### Left panel

- Editable text area or code editor with markdown syntax highlighting
- Copy and download buttons
- Spec validation badge (pass or fail with expandable details)

#### Right panel

- Page explorer grouped by detected section
- Inclusion toggles per page
- Score badges with breakdown tooltip
- Provenance badges (source of each description)
- `.md` badges (indicates markdown variant was found)
- `Update file from current selection` button

#### Preview mode UI differences

- No monitor panel
- No saved override history
- CTA to sign in and re-run as a full job with expanded crawl budget

### 17.4 Monitor detail

- Run history with status and duration
- Diff summaries per run
- Stale override warnings
- Last full reconciliation timestamp
- Delivery status for webhook and email, backed by `delivery_attempts`

---

## 18. Validation

Validation runs on every assembled file before it is stored.

### Checks

- Exactly one H1 at the top of the file
- Blockquote summary immediately follows H1 when present (not required for spec validity; see section 3 graceful degradation)
- No headings of any level (H2-H6) in the preamble section between the blockquote and the first file-list H2
- All section delimiters are H2; no H3+ headings anywhere in the generated output
- Every H2 section contains at least one markdown list entry in the format `- [name](url)` or `- [name](url): description`
- `## Optional` section present only when it contains entries
- No empty sections
- All links are valid absolute URLs with `http://` or `https://` scheme
- No duplicate URLs across sections

Validation errors are shown inline in the UI with line numbers and descriptions.

---

## 19. Observability

### MVP metrics

The system tracks a small set of operational metrics from day one to support debugging crawl quality and monitoring health:

- Jobs by status (complete, partial, failed) and by mode (preview vs full)
- Average crawl duration by genre
- Pages discovered vs pages successfully crawled per job
- LLM refinement rate and average token usage
- Monitor no-change rate vs update rate
- Delivery success rate by channel, tracked via `delivery_attempts`

### Structured logs

Every job and monitor run logs: job or monitor id, mode, target domain, detected genre, page counts (discovered, crawled, skipped, failed), whether LLM refinement ran, whether Browserless was used, and delivery outcomes. Logs redact all token and secret material.

### Post-launch additions

Detailed per-genre scoring distribution analysis, Browserless fallback rate trends, and per-domain crawl success rates can be added once there is enough usage data to make them actionable.

---

## 20. Testing Strategy

### Unit tests

- URL normalization: tracking param stripping, slash normalization, canonical dedup
- Scoring logic: base scoring, genre modifiers, threshold application
- Section grouping: page type to section mapping, collapse rules, Optional placement
- File assembly: spec-compliant markdown output, edge cases like no blockquote or single section
- Override application: each override type in isolation and combined
- Validation: positive and negative cases for every check
- SSRF validation: private IP ranges, redirect chains, DNS rebinding scenarios
- `robots.txt` parsing: user-agent precedence and crawl-delay behavior
- Webhook signing: signature generation, verification, replay-window rejection

### Integration tests

- End-to-end crawl against a set of local fixture sites (static HTML served by a test server) covering each genre
- Preview flow: create, poll, complete, download
- Override flow: generate, apply overrides, re-assemble, verify merge
- Monitor flow: initial crawl, simulate page change, verify targeted re-crawl and diff
- Crawl-delay handling: site declares high crawl delay, verify preview refusal and full-mode cap behavior

### Snapshot tests

- Golden-file tests comparing generated `llms.txt` output against expected output for each fixture site
- Catch unintended regressions in scoring, grouping, or formatting changes

### Manual QA reference sites

- Developer docs: a Next.js or Python library docs site
- E-commerce: a Shopify storefront
- Blog: a WordPress or Ghost blog with 50+ posts
- Personal: a simple portfolio site
- Institutional: a university department or nonprofit

---

## 21. Phased Scope

### MVP

- Preview mode and full mode
- Deterministic crawl, score, and group pipeline
- `.md` probing
- Limited LLM refinement
- Override snapshots and rollback
- Incremental monitoring plus full reconciliation
- Stable URL, webhook, and email delivery paths
- Security hardening and validation
- Core test suite: unit, integration, and snapshots
- Basic observability and delivery tracking

### V2

- GitHub PR delivery option
- Field-level diffs
- Public opt-in gallery
- Per-job advanced scoring customization

### V3

- Organization and team accounts
- API keys
- Advanced delivery logs and retry controls

---

## 22. Key Trade-offs

### Deterministic structure vs LLM structure

Deterministic structure is less flexible but more explainable, cheaper, and safer against hallucination. An LLM-driven pipeline could produce more creative section names or smarter grouping, but would be harder to debug, more expensive per run, and vulnerable to inconsistent output across runs.

### Preview persistence

Ephemeral preview storage adds complexity (separate tables, TTL cleanup), but it resolves the async polling problem without forcing signup. The alternative, synchronous generation, does not work for sites that take 30+ seconds to crawl.

### Probe hash + content hash

Maintaining two hashes adds schema complexity, but it makes incremental monitoring correct. `probe_hash` covers the lightweight check representation while `content_hash` covers the fully extracted text. Without both, monitoring would either miss changes (if comparing only lightweight data) or require full re-extraction on every check (expensive).

### Genre detection

Genre-aware scoring adds one more step, but improves quality across non-docs sites significantly. Without it, an e-commerce site's product pages would be scored the same as a developer docs site's product pages.

### Stable URL vs direct repo writes

Reverse proxy or rewrite is lower-friction than asking for repo access, while still allowing the user to serve a current file at `/llms.txt`. Repo write-back is deferred to V2 because it requires OAuth scopes, branch management, and conflict resolution.

### Re-run on preview-to-full conversion

Re-running the crawl rather than migrating preview data wastes the preview crawl results, but gives the user a strictly better result (more pages, higher budget) and avoids complex data migration between tables with different ownership semantics.

---

## 23. Open Questions

1. Is Sonnet needed for both summary and gap-filling, or should a cheaper model (such as Haiku) handle one-sentence page descriptions while Sonnet handles the site summary?
2. Should the product expose genre override controls in MVP, or only surface the detected genre and keep it automatic?
3. At what usage level does self-hosted Playwright become preferable to the Browserless.io API for cost and latency?
