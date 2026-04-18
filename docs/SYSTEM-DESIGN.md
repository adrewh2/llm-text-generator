# System Design

A visual overview. `docs/DESIGN.md` has the narrative; this file
exists so a reviewer can pattern-match the shape before reading prose.

---

## 1. Component diagram

Every arrow is a real network call or module boundary in the codebase.

```mermaid
flowchart TB
    subgraph Browser
        direction LR
        Landing["/"]
        Dash["/dashboard"]
        Result["/p/[id]"]
    end

    subgraph Vercel["Vercel Fluid Compute (Next.js App Router)"]
        direction TB
        APIP["POST /api/p<br/>submit crawl"]
        APIPID["GET /api/p/[id]<br/>poll job state"]
        APIPG["GET /api/pages + /download<br/>user history + zip"]
        APIM["GET /api/monitor<br/>daily cron handler"]
        APIW["POST /api/worker/crawl<br/>QStash-signed worker"]
        MW["middleware.ts<br/>session refresh"]
    end

    subgraph Upstash["Upstash — Vercel Marketplace"]
        direction LR
        Redis[("Redis<br/>rate-limit buckets")]
        QStash[("QStash<br/>durable job queue")]
    end

    Supa[("Supabase<br/>Postgres · Auth<br/>pages · jobs · user_requests")]
    Claude(("Anthropic<br/>Claude Haiku"))
    VCron{{"Vercel Cron<br/>0 0 * * *"}}
    Web[["Target websites<br/>robots · sitemap · pages"]]

    Landing -- submit URL --> APIP
    Dash -- list + delete --> APIPG
    Result -- poll every 1.5 s --> APIPID
    Browser -- any request --> MW
    MW -- getUser --> Supa

    APIP -- consumeRateLimit --> Redis
    APIP -- createJob + upsertUserRequest --> Supa
    APIP -- publishJSON --> QStash
    APIPID -- getJob --> Supa
    APIPG -- user_requests + pages --> Supa

    QStash -- signed POST --> APIW
    APIW -- runCrawlPipeline --> Supa
    APIW -- fetch HTML --> Web
    APIW -- rank + enrich + preamble --> Claude

    VCron --> APIM
    APIM -- getMonitoredPages --> Supa
    APIM -- signature compare --> Web
    APIM -- enqueueCrawl on drift --> QStash
```

### How to read it

- **Browser** routes only reach Vercel Fluid Compute. They never touch Upstash / Anthropic / target sites directly.
- **`POST /api/p`** is the fast path: validate → rate-limit → check cache → enqueue → return 201. It never runs the crawl itself.
- **`POST /api/worker/crawl`** is where the actual work happens. Every arrow from the worker to an external service (`Supa`, `Web`, `Claude`) is inside one ~30–60 s function invocation.
- **`GET /api/monitor`** is a separate entrypoint that fans out into the same queue. The worker doesn't know whether a job came from a user submission or from the cron.
- **Upstash services** are provisioned through the Vercel Marketplace, so the env vars are auto-injected into Production + Preview. No secrets in the codebase.

---

## 2. Crawl request lifecycle

One user submission, end to end. Time flows top-to-bottom.

```mermaid
sequenceDiagram
    autonumber
    participant U as Browser
    participant P as POST /api/p
    participant R as Upstash Redis
    participant DB as Supabase
    participant Q as Upstash QStash
    participant W as POST /api/worker/crawl
    participant T as Target site
    participant A as Anthropic

    U->>P: { url }
    P->>R: consumeRateLimit(user.id or IP)
    R-->>P: allowed
    P->>DB: SELECT from pages WHERE url = ?
    DB-->>P: miss or stale
    P->>DB: INSERT job (pending) + upsertUserRequest
    P->>Q: publishJSON({ jobId, url })
    Q-->>P: ack
    P-->>U: 201 { page_id }

    rect rgb(245,245,245)
        note right of Q: QStash holds the message<br/>and pushes to the worker URL
    end

    Q->>W: signed POST { jobId, url }
    W->>DB: UPDATE job.status = crawling

    W->>T: robots.txt, sitemap.xml, homepage
    T-->>W: HTML / XML

    W->>A: rankCandidateUrls (1 call)
    A-->>W: ranked URL list

    par worker pool, 5 concurrent page fetches
        W->>T: page 1..25
        T-->>W: HTML
    end

    W->>A: enrichBatch × ceil(pages/20)
    A-->>W: pageType · importance · section · description
    W->>A: llmSiteName + generateSitePreamble
    A-->>W: brand + preamble

    W->>DB: UPDATE jobs terminal + write pages.result
    W-->>Q: 200 OK
    Q->>Q: mark delivered

    loop client poll (until terminal status)
        U->>DB: GET /api/p/[id] every 1.5 s
    end

    note over U: After terminal: Vercel's edge CDN serves<br/>repeat polls from Cache-Control; updateJob<br/>revalidates sibling job ids on re-crawl.
```

### Failure modes and retries

- **`POST /api/p` returns 5xx** — browser shows an error; nothing enqueued, nothing lost.
- **QStash publish fails** (network / auth / wrong region) — `lib/jobQueue.ts` catches and falls through to `waitUntil(runCrawlPipeline(...))`. Same Fluid Compute instance runs the crawl; no retry safety, but the crawl isn't dropped.
- **Worker returns non-2xx** — QStash redelivers with exponential backoff, up to `retries: 3`. The pipeline sets `job.status = crawling` at entry, so a retry overwrites rather than duplicates state.
- **Anthropic 429 / 5xx** — the SDK's built-in retry handles it transparently (default `maxRetries: 2`, exponential backoff, `Retry-After` honoured — we haven't overridden this). User sees no difference; latency increases by the backoff window. If all retries exhaust, the specific LLM step falls through to its deterministic fallback and the crawl still completes. A custom retry wrapper with higher `maxRetries` + a global concurrency semaphore is called out in `SCALING.md` §3 as a follow-up.
- **Fluid Compute instance recycled mid-crawl** — worker never returns 200 → QStash treats as failure → redelivers. Crawl re-runs from scratch.

---

## 3. Where each subsystem is documented

| Area | Doc |
|---|---|
| Full narrative design (data model, pipeline steps, trade-offs) | [`DESIGN.md`](./DESIGN.md) |
| Threat model + controls | [`SECURITY.md`](./SECURITY.md) |
| Phase-2 scaling work (shipped + planned) | [`SCALING.md`](./SCALING.md) |
| Theoretical throughput, ceiling math, observability | [`PERFORMANCE.md`](./PERFORMANCE.md) |
| Manual test playbook | [`TESTING.md`](./TESTING.md) |

---

## 4. What sits where in the repo

```
app/
  page.tsx + LandingClient.tsx   landing, with server-resolved auth state
  dashboard/                     page history, delete, monitor status
  p/[id]/                        result viewer + poll loop
  login/                         OAuth entry
  api/
    p/                           POST submit, GET poll, DELETE history
    pages/                       history list + zip export
    monitor/                     daily cron handler
    worker/crawl/                QStash-signed worker (the actual crawl host)
  auth/callback/                 OAuth return

lib/
  config.ts                      all tunable constants
  store.ts                       Supabase access layer
  rateLimit.ts                   Upstash Redis + in-memory fallback
  jobQueue.ts                    QStash publish + waitUntil fallback
  supabase/{client,server}.ts    Supabase client factories
  crawler/
    pipeline.ts                  orchestration — the one function the worker calls
    {robots,sitemap,fetchPage,
     safeFetch,readBounded,ssrf,
     spaCrawler,discover,extract,
     markdownProbe,classify,
     genre,score,group,
     llmEnrich,assemble,
     siteName,urlLabel,
     monitor,validate}.ts        individual pipeline stages
  env.ts, log.ts                 env + logger helpers

supabase/migration.sql           full schema + RLS
middleware.ts                    session refresh + /dashboard gate
next.config.ts                   CSP + security headers
vercel.json                      function durations + cron schedule
```
