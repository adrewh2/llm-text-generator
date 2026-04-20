# Manual Test Playbook

Comprehensive pre-submission checklist. Every test is executable from
the CLI unless explicitly marked **[browser]**. Copy-pasteable against a
local dev server; production variants called out per-test.

Targets about 15 minutes end-to-end; individual layers are independent
and can be re-run in isolation.

---

## 0. Prereqs

### Environment

- `.env.local` populated — see [`README.md#3-fill-in-envlocal`](../README.md#3-fill-in-envlocal). Required for tests:
  `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `NEXT_PUBLIC_SUPABASE_URL`,
  `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `ANTHROPIC_API_KEY`, `CRON_SECRET`.
- Upstash Redis + QStash + Sentry vars optional locally; tests that
  exercise those paths are clearly marked **[production-only]**.
- `npm run dev` running on `http://localhost:3000` (or set `BASE_URL`
  to test against a deployed environment).
- `jq`, `curl`, `psql` on PATH.
- A signed-in test account available in Supabase Auth (only needed
  for the auth-required layers).

### Shell setup

Export these once at the start of a session — every test below assumes
they're set:

```bash
export BASE_URL="http://localhost:3000"           # or https://your-domain.vercel.app
set -a; source .env.local; set +a                 # load env into shell
export DATABASE_URL="postgresql://postgres.<ref>:<pass>@aws-0-<region>.pooler.supabase.com:6543/postgres"
# ↑ copy from Supabase dashboard → Project Settings → Database → Connection string (transaction mode)
```

Quick DB connectivity smoke — should print the three table names:
```bash
psql "$DATABASE_URL" -c "\dt" | grep -E "pages|jobs|user_requests"
```

### Reset helper

Used between tests to get a clean slate. **Destructive** — only run
against a test project.

```bash
# Drop all data but keep schema + RLS policies.
psql "$DATABASE_URL" <<'SQL'
DELETE FROM user_requests;
DELETE FROM jobs;
DELETE FROM pages;
SQL
```

For rate-limit state:
```bash
# Upstash CLI path — if wired locally
# curl -s "$UPSTASH_REDIS_REST_URL/flushdb" -H "Authorization: Bearer $UPSTASH_REDIS_REST_TOKEN"
# In-memory fallback resets on dev-server restart — kill & restart `npm run dev`.
```

---

## 1. HTTP smoke + input validation

No DB or rate-limit state needed.

### 1.1 Landing page, robots, sitemap

```bash
curl -s -o /dev/null -w "GET /           → HTTP %{http_code}  %{time_total}s\n" "$BASE_URL/"
curl -s -o /dev/null -w "GET /robots.txt → HTTP %{http_code}  %{time_total}s\n" "$BASE_URL/robots.txt"
curl -s -o /dev/null -w "GET /sitemap.xml→ HTTP %{http_code}  %{time_total}s\n" "$BASE_URL/sitemap.xml"
```
**Expect:** all three return `200`.

### 1.2 Missing body → 400

```bash
curl -s -o /dev/null -w "%{http_code}\n" -X POST "$BASE_URL/api/p" \
  -H "Content-Type: application/json" -d '{}'
```
**Expect:** `400`.

### 1.3 Non-string URL → 400

```bash
curl -s -X POST "$BASE_URL/api/p" \
  -H "Content-Type: application/json" -d '{"url":42}' | jq -r '.error'
```
**Expect:** `url is required`.

### 1.4 Non-http(s) scheme → 400

```bash
curl -s -X POST "$BASE_URL/api/p" \
  -H "Content-Type: application/json" -d '{"url":"ftp://example.com"}' | jq -r '.error'
curl -s -X POST "$BASE_URL/api/p" \
  -H "Content-Type: application/json" -d '{"url":"javascript:alert(1)"}' | jq -r '.error'
```
**Expect:** both print `Invalid URL — must be http:// or https://`.

### 1.5 Over-length URL → 400

```bash
LONG="https://example.com/$(head -c 3000 /dev/urandom | base64)"
curl -s -X POST "$BASE_URL/api/p" \
  -H "Content-Type: application/json" -d "{\"url\":\"$LONG\"}" | jq -r '.error'
```
**Expect:** `URL is too long`.

### 1.6 Invalid JSON body → 400

```bash
curl -s -o /dev/null -w "%{http_code}\n" -X POST "$BASE_URL/api/p" \
  -H "Content-Type: application/json" --data-raw '{broken'
```
**Expect:** `400`.

---

## 2. Security headers + CSP

### 2.1 All security headers present

```bash
curl -sI "$BASE_URL/" | grep -iE "^(content-security-policy|x-frame-options|x-content-type-options|referrer-policy|permissions-policy):" | wc -l
```
**Expect:** `5`.

### 2.2 CSP includes Sentry + Supabase hosts

```bash
curl -sI "$BASE_URL/" | grep -i "^content-security-policy:" | tr ';' '\n' | grep -E "connect-src|worker-src"
```
**Expect (production):** `connect-src` line contains both `*.supabase.co`
and `*.ingest.sentry.io`; `worker-src` line contains `blob:`.

### 2.3 X-Frame-Options denies external framing

```bash
curl -sI "$BASE_URL/" | grep -i "^x-frame-options:"
```
**Expect:** `SAMEORIGIN`.

---

## 3. SSRF refusal

### 3.1 Private IPv4 literals rejected

Cache-bust between requests by appending a unique query suffix. Each
case should record an internal "unsafe URL" error that the `/api/p/[id]`
response scrubs to a generic user-facing string.

```bash
for url in \
  "http://127.0.0.1/" \
  "http://10.0.0.1/" \
  "http://172.16.0.1/" \
  "http://192.168.0.1/" \
  "http://169.254.169.254/" ; do
  JOB=$(curl -s -X POST "$BASE_URL/api/p" \
    -H "Content-Type: application/json" -d "{\"url\":\"$url\"}" | jq -r '.page_id // empty')
  if [ -n "$JOB" ]; then
    sleep 2
    STATUS=$(curl -s "$BASE_URL/api/p/$JOB" | jq -r '.status')
    ERROR=$(curl -s "$BASE_URL/api/p/$JOB" | jq -r '.error')
    echo "$url → status=$STATUS  error=$ERROR"
  else
    echo "$url → rejected at submit (rate limit or validation)"
  fi
done
```
**Expect:** every case either rejected at submit, or `status=failed`
with `error="This URL can't be crawled."` (the scrubbed form of the
internal `Unsafe URL (forbidden IP range …)` message).

### 3.2 Loopback hostname rejected

```bash
JOB=$(curl -s -X POST "$BASE_URL/api/p" \
  -H "Content-Type: application/json" -d '{"url":"http://localhost/"}' | jq -r '.page_id')
sleep 2
curl -s "$BASE_URL/api/p/$JOB" | jq '{status, error}'
```
**Expect:** `status=failed`, `error="This URL can't be crawled."`.

### 3.3 IPv6 loopback / link-local rejected

```bash
for url in \
  "http://[::1]/" \
  "http://[fe80::1]/" ; do
  curl -s -X POST "$BASE_URL/api/p" \
    -H "Content-Type: application/json" -d "{\"url\":\"$url\"}" | jq -c
done
```
**Expect:** the job either rejects at submit or lands as `failed`.

### 3.4 IPv4-mapped IPv6 rejected

```bash
JOB=$(curl -s -X POST "$BASE_URL/api/p" \
  -H "Content-Type: application/json" -d '{"url":"http://[::ffff:127.0.0.1]/"}' | jq -r '.page_id')
sleep 2
curl -s "$BASE_URL/api/p/$JOB" | jq -r '.error'
```
**Expect:** `This URL can't be crawled.`

### 3.5 Non-default port rejected

Any port other than the implicit `:80` for `http` / `:443` for `https`
is rejected pre-DNS — protects against the crawler being pointed at
non-HTTP services (Redis, SSH, SMTP, etc.) on public IPs.

```bash
for url in \
  "http://example.com:8080/" \
  "http://example.com:6379/" \
  "https://example.com:8443/" ; do
  JOB=$(curl -s -X POST "$BASE_URL/api/p" \
    -H "Content-Type: application/json" -d "{\"url\":\"$url\"}" | jq -r '.page_id // empty')
  if [ -n "$JOB" ]; then
    sleep 2
    curl -s "$BASE_URL/api/p/$JOB" | jq -c '{status, error}'
  else
    echo "$url → rejected at submit"
  fi
done
```
**Expect:** every case either rejected at submit or `status=failed`
with `error="This URL can't be crawled."` (the scrubbed form of the
internal `Unsafe URL (non-default port not allowed (…))` message).

The default ports still work (test later, not during SSRF battery —
these will actually try to crawl the site):
```bash
# https://example.com (default :443) and http://example.com (default :80)
# should NOT be rejected by port check; they hit whatever DNS resolution
# returns and proceed from there.
```

### 3.6 Error-scrub doesn't leak internals

Verify the **internal** `jobs.error` row contains the resolved-IP
details, but the **API** response doesn't:

```bash
psql "$DATABASE_URL" -c "SELECT error FROM jobs WHERE status = 'failed' ORDER BY created_at DESC LIMIT 1;"
# Internal error may read: "Unsafe URL (forbidden IP range (127.0.0.1)): http://localhost/"

curl -s "$BASE_URL/api/p/$(psql "$DATABASE_URL" -t -A -c "SELECT id FROM jobs WHERE status='failed' ORDER BY created_at DESC LIMIT 1;")" | jq -r '.error'
# User-facing: "This URL can't be crawled."
```
**Expect:** internal message contains IP / forbidden-range detail; API
response returns a generic string with no IP reference.

---

## 4. Rate limiting (two-bucket)

Two buckets per principal (SUBMIT abuse floor + NEW_CRAWL budget
guard) — both must be clear for a new crawl to dispatch. Canonical
table + rationale in [`SECURITY.md §2`](./SECURITY.md#2-abuse--rate-limiting);
capacities in `lib/config.ts` → `rateLimit`. The assertions in
§4.1–§4.3 below reflect the current defaults (ANON NEW_CRAWL = 3 /hr,
AUTH NEW_CRAWL = 50 /hr). Local dev without Upstash uses per-instance
in-memory buckets that reset on dev-server restart.

### 4.1 NEW_CRAWL limit hit on the 4th novel anon URL

```bash
# Fresh process to reset in-memory buckets (local dev only)
# — kill + restart `npm run dev` if you need a clean slate.

for i in 1 2 3 4; do
  RESP=$(curl -s -X POST "$BASE_URL/api/p" \
    -H "Content-Type: application/json" \
    -d "{\"url\":\"https://ratetest-$i-$(date +%s).example.com\"}")
  echo "$i: $(echo "$RESP" | jq -c '{page_id, error, reason, signInPrompt}')"
done
```
**Expect:**
- Calls 1-3 succeed with `page_id` set (the URLs are bogus so will fail
  downstream, but the submit branch passes).
- Call 4 returns `{"error":"You've hit your limit for generating new pages.", "reason":"new_crawl_quota", "retryAfterSec":N, "signInPrompt":true}`.

### 4.2 Cache hit does *not* burn NEW_CRAWL

Critical behavior: a user who's hit their new-crawl quota can still
access already-cached URLs. After 4.1 runs, submit an URL that's already
in cache:

```bash
# First, ensure a cached entry exists (pick a real site you've crawled before):
TARGET="https://llmstxt.org"
# If not cached, crawl once:
curl -s -X POST "$BASE_URL/api/p" -H "Content-Type: application/json" \
  -d "{\"url\":\"$TARGET\"}" | jq -c
# Wait ~60s for completion; then run 4.1 to burn NEW_CRAWL; then:
curl -s -X POST "$BASE_URL/api/p" -H "Content-Type: application/json" \
  -d "{\"url\":\"$TARGET\"}" | jq -c
```
**Expect:** cache-hit response `{"page_id":"...","cached":true}` even
after NEW_CRAWL is exhausted. The 200 proves SUBMIT charges but
NEW_CRAWL doesn't.

### 4.3 429 has `Retry-After` header + structured body

```bash
# After burning NEW_CRAWL from 4.1:
curl -s -D - -X POST "$BASE_URL/api/p" -H "Content-Type: application/json" \
  -d "{\"url\":\"https://another-unique-$(date +%s).example.com\"}" -o /tmp/body.json
cat /tmp/body.json | jq
```
**Expect:** headers include `Retry-After: N`; body has `reason`,
`retryAfterSec`, `signInPrompt` fields.

### 4.4 SUBMIT floor — [skip unless you have time]

Anon SUBMIT is 60/hr, auth is 300/hr. Realistic testing would require
61+ requests; use the reset helper if you must. Skipping is fine —
coverage is implicit in 4.1 (SUBMIT was charged on all 4 calls and
the 4th still reached the NEW_CRAWL check).

---

## 5. Crawl pipeline

### 5.1 End-to-end new crawl

```bash
# Reset DB for a clean slate (optional):
# psql "$DATABASE_URL" -c "DELETE FROM user_requests; DELETE FROM jobs; DELETE FROM pages;"

TARGET="https://nextjs.org"
JOB=$(curl -s -X POST "$BASE_URL/api/p" -H "Content-Type: application/json" \
  -d "{\"url\":\"$TARGET\"}" | jq -r '.page_id')
echo "Job: $JOB"

# Poll until terminal, up to 90s
for i in {1..30}; do
  STATUS=$(curl -s "$BASE_URL/api/p/$JOB" | jq -r '.status')
  echo "[$i] status=$STATUS"
  case "$STATUS" in
    complete|partial|failed) break ;;
  esac
  sleep 3
done

# Final state
curl -s "$BASE_URL/api/p/$JOB" | jq '{status, genre, siteName, crawled:(.progress.crawled), failed:(.progress.failed)}'
```
**Expect:** status progresses through `crawling → enriching → scoring →
assembling → complete` within ~60s. Final `crawled >= 10`, `siteName`
is a short brand string (e.g. `Next.js`), `genre` is a known value.

### 5.2 Spec-valid output

```bash
curl -s "$BASE_URL/api/p/$JOB" | jq -r '.result' | head -5
```
**Expect:** first line is `# <SiteName>`, line 2 blank, line 3 is a
blockquote (`> …`) or preamble text. No `###` headings.

Programmatic spec validation (using the in-app validator):
```bash
cat > /tmp/validate.mjs <<'EOF'
import { validateLlmsTxt } from "./lib/crawler/output/validate.ts"
const text = await fetch(process.env.URL).then(r => r.json()).then(j => j.result)
const result = validateLlmsTxt(text)
console.log(JSON.stringify(result, null, 2))
EOF
# Easier: eyeball the "Spec valid" badge in the browser, OR:
curl -s "$BASE_URL/api/p/$JOB" | jq -r '.result' | \
  awk '
    NR==1 && !/^# / {print "FAIL: first content line is not H1"; exit 1}
    /^# / {h1++}
    /^### / {print "FAIL: H3+ not allowed at line "NR; exit 1}
    END {if (h1 != 1) {print "FAIL: expected exactly 1 H1, found "h1; exit 1} else print "OK"}
  '
```
**Expect:** prints `OK`.

### 5.3 Cache-hit replay

```bash
# Re-submit the same URL; should return cached=true immediately.
curl -s -X POST "$BASE_URL/api/p" -H "Content-Type: application/json" \
  -d "{\"url\":\"$TARGET\"}" | jq -c
```
**Expect:** `{"page_id":"<same-job-id>","cached":true}`, returned
synchronously (no crawl kicks off). The simulated-progress animation
is a browser-only concern — verify by opening
`$BASE_URL/p/<job>?simulate=1` and watching the stepper play out.

### 5.4 In-flight attach (concurrent submit)

```bash
TARGET="https://httpbin.org/html?$(date +%s)"   # unique, forces new crawl
(curl -s -X POST "$BASE_URL/api/p" -H "Content-Type: application/json" -d "{\"url\":\"$TARGET\"}" > /tmp/a.json) &
sleep 0.5
curl -s -X POST "$BASE_URL/api/p" -H "Content-Type: application/json" -d "{\"url\":\"$TARGET\"}" > /tmp/b.json
wait
jq -c '{page_id,cached}' /tmp/a.json /tmp/b.json
```
**Expect:** both responses carry the same `page_id`. The second call
attached to the in-flight job rather than kicking off a duplicate.
(A racy edge exists if both land inside the TOCTOU window — documented
in SECURITY.md §13.)

### 5.5 Stale TTL triggers recrawl

```bash
# Age a page past the 24h TTL and re-submit.
psql "$DATABASE_URL" -c "UPDATE pages SET updated_at = NOW() - INTERVAL '25 hours' WHERE url = '$TARGET';"
curl -s -X POST "$BASE_URL/api/p" -H "Content-Type: application/json" \
  -d "{\"url\":\"$TARGET\"}" | jq -c
```
**Expect:** response is `{"page_id":"<NEW-uuid>","cached":false}` with
a new job id — a fresh crawl was dispatched. Old `pages.result` stays
in place until the new run completes.

### 5.6 www / non-www deduplication

```bash
# speedtest.net redirects to www.speedtest.net — we should store one row
curl -s -X POST "$BASE_URL/api/p" -H "Content-Type: application/json" \
  -d '{"url":"https://speedtest.net"}' | jq -c
curl -s -X POST "$BASE_URL/api/p" -H "Content-Type: application/json" \
  -d '{"url":"https://www.speedtest.net"}' | jq -c
psql "$DATABASE_URL" -c "SELECT COUNT(*) FROM pages WHERE url LIKE '%speedtest.net%';"
```
**Expect:** both submissions return the same `page_id`; one row in
`pages`.

---

## 6. Output quality

### 6.1 Site-name is a clean brand

```bash
psql "$DATABASE_URL" -c "SELECT url, site_name FROM pages ORDER BY updated_at DESC LIMIT 5;"
```
**Expect:** `site_name` is a short 1-4 word brand (`Next.js`, `Stripe`,
`Uber Eats`) — never a tagline, never a cheerio-concatenated mess.

### 6.2 External references appear

```bash
# Site with obvious outbound refs (spec links, canonical docs)
TARGET="https://fastht.ml"
JOB=$(curl -s -X POST "$BASE_URL/api/p" -H "Content-Type: application/json" \
  -d "{\"url\":\"$TARGET\"}" | jq -r '.page_id')
# ...wait for completion...
psql "$DATABASE_URL" <<SQL
SELECT
  jsonb_array_elements(crawled_pages)->>'url' AS url,
  jsonb_array_elements(crawled_pages)->>'section' AS section
FROM pages WHERE url = '$TARGET';
SQL
```
**Expect:** at least one row where `url` has a hostname different from
`$TARGET` (external ref, e.g. pointing at `htmx.org` or a GitHub repo).

### 6.3 Markdown-variant probing

```bash
# Site that exposes .md siblings — e.g. docs.fasthtml.com
TARGET="https://docs.fastht.ml/"
JOB=$(curl -s -X POST "$BASE_URL/api/p" -H "Content-Type: application/json" \
  -d "{\"url\":\"$TARGET\"}" | jq -r '.page_id')
# ...wait for completion...
curl -s "$BASE_URL/api/p/$JOB" | jq -r '.result' | grep -E '\.md\)' | head -5
```
**Expect:** at least one link ends in `.md)` (the crawler preferred the
markdown-variant URL where one existed, per the llmstxt.org spec).

### 6.4 URLs containing parens are percent-encoded

```bash
# Wikipedia URLs often contain literal parens (e.g. /wiki/Something_(film))
TARGET="https://en.wikipedia.org/wiki/Special:Random"
# ...after a crawl that produced a paren-URL entry in crawled_pages...
curl -s "$BASE_URL/api/p/$JOB" | jq -r '.result' | grep -E "%28|%29" | head -3
```
**Expect:** if any `(` / `)` appeared in a source URL, the rendered
markdown uses `%28` / `%29` so the link doesn't terminate early.

### 6.5 Full-disallow robots.txt produces a notice

```bash
# Find a site whose /robots.txt has `Disallow: /` for our UA (try any
# major tracker-blocking site or set up a test site yourself). Submit
# and inspect:
curl -s "$BASE_URL/api/p/$JOB" | jq -r '.result' | grep -i "robots.txt"
```
**Expect:** output contains a `> ⚠️ Note: This site's robots.txt
disallows all crawling (Disallow: /). …` blockquote. The crawl
still succeeds, just with homepage-only data.

---

## 7. Authentication + RLS

Browser-driven. Use two test accounts (user A + user B) if available.

### 7.1 [browser] OAuth sign-in works

Sign in as user A via GitHub or Google. **Expect:**
- Redirect returns to `/dashboard` with account email in top-right.
- No flash of "Sign in" on first paint (server-side auth resolution).

### 7.2 Unauthenticated `/dashboard` redirects to `/login`

```bash
curl -s -o /dev/null -w "%{http_code} %{redirect_url}\n" -L --max-redirs 0 "$BASE_URL/dashboard"
# If middleware redirects, look for Location header
curl -sI "$BASE_URL/dashboard" | grep -iE "^(http|location)"
```
**Expect:** `HTTP/2 307` (or 302) with `location: /login`.

### 7.3 Dashboard API requires auth

```bash
curl -s -o /dev/null -w "%{http_code}\n" "$BASE_URL/api/pages"
curl -s -o /dev/null -w "%{http_code}\n" "$BASE_URL/api/pages/download"
curl -s -o /dev/null -w "%{http_code}\n" -X DELETE "$BASE_URL/api/p/request?pageUrl=https://x.com"
```
**Expect:** all three return `401`.

### 7.4 [browser] RLS scoping

As user A, submit URL `X`. Sign out; sign in as user B. **Expect:**
- User B's `/dashboard` does not list URL `X`.
- User B can still view `$BASE_URL/p/<X's job id>` directly (jobs are
  public-read by design; history is private).

Verify RLS at the DB level (service-role bypasses it, so direct SQL
with the anon key is the real check):
```bash
# With anon key — user_requests should require auth context
curl -s "$NEXT_PUBLIC_SUPABASE_URL/rest/v1/user_requests?select=page_url" \
  -H "apikey: $NEXT_PUBLIC_SUPABASE_ANON_KEY" | jq
```
**Expect:** empty array `[]` (RLS blocks anon reads).

### 7.5 [browser] SIGNED_OUT clears client cache

As user A, view a result page. Sign out from another tab. Return to
the result tab — the per-tab `jobCache` should clear via the Supabase
`onAuthStateChange` listener.

### 7.6 Delete from history

```bash
# As signed-in user, with a session cookie captured into SESSION_COOKIE:
curl -s -X DELETE "$BASE_URL/api/p/request?pageUrl=https://nextjs.org" \
  -b "$SESSION_COOKIE" -w "%{http_code}\n"
```
**Expect:** `204`. The row no longer appears in `/api/pages`.

---

## 8. Response shapes + caching

### 8.1 Terminal job responses carry long-TTL cache-control

```bash
# Find a terminal job:
JOB=$(psql "$DATABASE_URL" -t -A -c "SELECT id FROM jobs WHERE status IN ('complete','partial','failed') ORDER BY created_at DESC LIMIT 1;")
curl -sI "$BASE_URL/api/p/$JOB" | grep -i "^cache-control:"
```
**Expect:** `cache-control: public, s-maxage=86400, stale-while-revalidate=604800`.

### 8.2 In-flight job responses are no-store

```bash
# Kick off a new crawl and grab the job id while it's still running
JOB=$(curl -s -X POST "$BASE_URL/api/p" -H "Content-Type: application/json" \
  -d "{\"url\":\"https://nextjs.org?cache-bust=$(date +%s)\"}" | jq -r '.page_id')
curl -sI "$BASE_URL/api/p/$JOB" | grep -i "^cache-control:"
```
**Expect:** `cache-control: no-store`.

### 8.3 404 on unknown job id

```bash
curl -s -o /dev/null -w "%{http_code}\n" "$BASE_URL/api/p/00000000-0000-0000-0000-000000000000"
```
**Expect:** `404`.

### 8.4 GET `/api/p/[id]` bumps `last_requested_at` on any non-failed status

```bash
TARGET="https://nextjs.org"
JOB=$(psql "$DATABASE_URL" -t -A -c "SELECT id FROM jobs WHERE page_url = '$TARGET' ORDER BY created_at DESC LIMIT 1;")
BEFORE=$(psql "$DATABASE_URL" -t -A -c "SELECT last_requested_at FROM pages WHERE url = '$TARGET';")
sleep 2
curl -s "$BASE_URL/api/p/$JOB" > /dev/null
AFTER=$(psql "$DATABASE_URL" -t -A -c "SELECT last_requested_at FROM pages WHERE url = '$TARGET';")
echo "before: $BEFORE"
echo "after:  $AFTER"
```
**Expect:** `after > before` if the job was not in `failed` status.

---

## 9. Dashboard APIs

### 9.1 Pagination respects `offset` + `limit`

```bash
# As signed-in user, with $SESSION_COOKIE:
curl -s "$BASE_URL/api/pages?offset=0&limit=5" -b "$SESSION_COOKIE" | jq '{pages:(.pages|length), hasMore}'
```
**Expect:** `pages` length ≤ 5; `hasMore` boolean reflects remaining
rows. With `limit` > `PAGES_MAX_LIMIT` (50), it clamps to 50.

### 9.2 Download zip integrity

```bash
curl -s "$BASE_URL/api/pages/download" -b "$SESSION_COOKIE" -o /tmp/history.zip
file /tmp/history.zip
unzip -l /tmp/history.zip | head
```
**Expect:** file is a valid zip; contents include an `llms-txt/` folder
with one `.txt` per completed page; filenames disambiguated with `-2`,
`-3` suffixes on hostname collisions.

### 9.3 Empty history returns 404 on download

```bash
# With a user who has no history:
curl -s -o /dev/null -w "%{http_code}\n" "$BASE_URL/api/pages/download" -b "$EMPTY_USER_COOKIE"
```
**Expect:** `404`.

---

## 10. Monitor cron

### 10.1 Auth negative check

```bash
curl -s -o /dev/null -w "%{http_code}\n" "$BASE_URL/api/monitor"
curl -s -o /dev/null -w "%{http_code}\n" -H "Authorization: Bearer wrong-token" "$BASE_URL/api/monitor"
```
**Expect:** both `401`.

### 10.2 Auth positive check + response shape

```bash
curl -s -H "Authorization: Bearer $CRON_SECRET" "$BASE_URL/api/monitor" | jq 'keys'
```
**Expect:** `["changed","checked","errors","recrawls","stuckFailed","swept"]`.

### 10.3 First-check seeds signatures (no re-crawl fires)

```bash
psql "$DATABASE_URL" -c "UPDATE pages SET content_signature = NULL;"
curl -s -H "Authorization: Bearer $CRON_SECRET" "$BASE_URL/api/monitor" | jq '{checked, changed, recrawls}'
```
**Expect:** `checked > 0`, `changed = 0`, `recrawls = []` — first-check
behavior records a baseline without triggering a re-crawl.

### 10.4 Changed signature triggers recrawl dispatch

```bash
psql "$DATABASE_URL" -c "UPDATE pages SET content_signature = 'stale-sig' WHERE monitored = true;"
curl -s -H "Authorization: Bearer $CRON_SECRET" "$BASE_URL/api/monitor" | jq '{checked, changed, recrawls:(.recrawls|length)}'
```
**Expect:** `changed > 0`, `recrawls` length equals the number of
changed pages.

### 10.5 Stale-page sweep

```bash
# Age one page past the 5-day stale window
TARGET="https://nextjs.org"
psql "$DATABASE_URL" -c "UPDATE pages SET last_requested_at = NOW() - INTERVAL '6 days' WHERE url = '$TARGET';"
curl -s -H "Authorization: Bearer $CRON_SECRET" "$BASE_URL/api/monitor" | jq '.swept'
psql "$DATABASE_URL" -c "SELECT monitored FROM pages WHERE url = '$TARGET';"
```
**Expect:** `swept >= 1`; `monitored = f` on the aged row.

### 10.6 Stuck-job sweep

```bash
# Pin a non-terminal job past the 15-min threshold
JOB=$(psql "$DATABASE_URL" -t -A -c "SELECT id FROM jobs WHERE status IN ('complete','partial','failed') ORDER BY created_at DESC LIMIT 1;")
psql "$DATABASE_URL" -c "UPDATE jobs SET status = 'crawling', updated_at = NOW() - INTERVAL '20 minutes' WHERE id = '$JOB';"
curl -s -H "Authorization: Bearer $CRON_SECRET" "$BASE_URL/api/monitor" | jq '.stuckFailed'
psql "$DATABASE_URL" -c "SELECT status, error FROM jobs WHERE id = '$JOB';"
```
**Expect:** `stuckFailed >= 1`; the row is now `status='failed'` with
`error='Worker did not complete in time'`.

### 10.7 Same-host delay respected

Only observable at scale. With 10+ monitored pages on the same host,
total cron duration should be ≈ `N × SAME_HOST_DELAY_MS` (400 ms).
Verify via server logs (Vercel dashboard → Logs → `/api/monitor`) or
local console timestamps.

---

## 11. Production-only verification

Run against a deployed `$BASE_URL=https://<your-domain>.vercel.app`
(or the production alias).

### 11.1 QStash end-to-end

```bash
# Submit a unique URL and confirm a QStash event fires + lands on the worker.
TARGET="https://httpbin.org/html?$(date +%s)"
JOB=$(curl -s -X POST "$BASE_URL/api/p" -H "Content-Type: application/json" \
  -d "{\"url\":\"$TARGET\"}" | jq -r '.page_id')
echo "Check Upstash Console → QStash → Events for a POST to $BASE_URL/api/worker/crawl"
echo "Job: $JOB"
```
**Expect:** In Upstash Console, one event with `Status: Delivered` and
a 200-series response code from `/api/worker/crawl`. If `Status: Failed`
appears, check the delivery URL — it should resolve to the production
alias, not a per-deployment Vercel URL (which is gated by Deployment
Protection).

### 11.2 QStash worker rejects unsigned requests

```bash
# Direct POST to the worker without a QStash signature header should 401
curl -s -o /dev/null -w "%{http_code}\n" -X POST "$BASE_URL/api/worker/crawl" \
  -H "Content-Type: application/json" \
  -d "{\"jobId\":\"00000000-0000-0000-0000-000000000000\",\"url\":\"https://example.com\"}"
```
**Expect:** `401` (Upstash signature verification failed).

### 11.3 Sentry captures errors

```bash
# Force a crawl to land in `failed` via DNS resolution failure
curl -s -X POST "$BASE_URL/api/p" -H "Content-Type: application/json" \
  -d "{\"url\":\"https://this-domain-does-not-exist-asdfghjkl-$(date +%s).com\"}"
echo "Check Sentry → Issues tab within ~30s"
```
**Expect:** a new issue appears in Sentry within ~30s with:
- `context: worker.crawl` or `context: pipeline` tag
- Stack trace showing the DNS failure
- Not filtered (DNS failures aren't in `ignoreErrors`).

Submit a benign-but-filtered case to verify `ignoreErrors` works:
```bash
curl -s -X POST "$BASE_URL/api/p" -H "Content-Type: application/json" \
  -d '{"url":"http://127.0.0.1/"}'
# SSRF rejection should NOT surface as a new Sentry issue.
```

### 11.4 Sentry DSN reachable from browser

Open `$BASE_URL/` in a browser with devtools → Network tab. Look for
a request to `*.ingest.sentry.io` during page load (or on a synthetic
error). **Expect:** status 200 or 429; CSP doesn't block it.

### 11.5 Vercel Cron schedule live

```bash
# Via vercel CLI:
vercel crons ls
# or check Vercel dashboard → Settings → Cron Jobs
```
**Expect:** one entry for `/api/monitor` at `0 0 * * *`.

### 11.6 Production middleware cookie forward

Visit `/dashboard` unauthenticated — should redirect to `/login` with
the Supabase session cookie still set (a refresh that would've been
dropped in the pre-fix middleware). No programmatic check — verify
by signing in then revisiting `/dashboard`: no re-authentication prompt.

---

## 12. Cleanup

Leaves the project in a clean post-test state:

```bash
# Wipe crawl state (preserves schema + RLS)
psql "$DATABASE_URL" <<'SQL'
DELETE FROM user_requests;
DELETE FROM jobs;
DELETE FROM pages;
SQL

# Reset rate-limit buckets
# - In-memory: restart `npm run dev`
# - Upstash:   `curl -X POST "$UPSTASH_REDIS_REST_URL/flushdb" -H "Authorization: Bearer $UPSTASH_REDIS_REST_TOKEN"`
```

---

## Appendix A: Full battery script

Run in order — each section leaves DB/rate state usable for the next.
Expected total runtime: ~10 min (mostly waiting on the 60s crawl).

```
Layer 0  → set env + verify DB connectivity
Layer 1  → HTTP smoke + input validation   [~10s]
Layer 2  → security headers                [~5s]
Layer 3  → SSRF refusal                    [~30s]
Layer 5.1→ end-to-end crawl                [~90s]
Layer 5.2→ spec validation of the result   [~2s]
Layer 5.3→ cache hit                        [~2s]
Layer 6.1→ site-name check                  [~2s]
Layer 4.1→ NEW_CRAWL exhaustion            [~5s]
Layer 4.2→ cache-hit doesn't burn quota    [~5s]
Layer 7.2→ /dashboard redirect              [~5s]
Layer 7.3→ dashboard API 401s               [~5s]
Layer 8  → cache-control headers            [~5s]
Layer 10 → monitor cron (all 6 sub-tests)  [~60s total]
Layer 12 → cleanup                          [~2s]
```

Mark anything in **[browser]** as manual; the rest is scriptable. If
any layer fails, jump to [When a step fails](#when-a-step-fails) below.

---

## When a step fails

1. **Check dev-server console output** for the latest `[pipeline]`,
   `[monitor]`, `[enqueueCrawl]`, `[rateLimit]`, or `[POST /api/p]` log
   lines. In production, use Vercel dashboard → Logs.
2. **Inspect the failing job row directly:**
   ```sql
   SELECT id, status, progress, error FROM jobs
   WHERE page_url = '<url>' ORDER BY created_at DESC LIMIT 5;
   ```
3. **Check Sentry** (production only) → Issues tab filtered by the
   relevant `context` tag.
4. **For cache issues,** delete the row and re-submit:
   ```sql
   DELETE FROM pages WHERE url = '<url>';
   ```
5. **For auth issues,** clear cookies (the Supabase session cookie is
   `sb-<project-ref>-auth-token`) and re-sign-in.
6. **For rate-limit issues on local dev,** restart `npm run dev` (in-memory buckets reset on cold start).
