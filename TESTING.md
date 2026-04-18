# Manual Test Playbook

No automated test suite yet — this is the checklist a reviewer or dev
runs through before shipping. Takes about 10 minutes end-to-end.

## Prereqs

- `.env` populated with `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`,
  `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`,
  `ANTHROPIC_API_KEY`, `CRON_SECRET`.
- `npm run dev` running on port 3000.
- Signed-in test account available in Supabase Auth (GitHub or Google).

Every section marks whether the check is **CLI** or **browser**.

---

## 1. Smoke — anon path works

**Browser.** Open http://localhost:3000 → input autofocuses.
**Browser.** Submit a URL you haven't crawled before (e.g. `https://nextjs.org`).
**Browser.** Redirects to `/p/<uuid>`, `ProgressPane` renders, steps animate
   through `crawling → enriching → scoring → assembling`.
**Browser.** Result pane shows a valid `llms.txt` with a "Spec valid" badge
   in the header. Copy + Download buttons work.

**CLI.** Confirm the crawl landed in the DB:
```sql
SELECT url, site_name, genre, jsonb_array_length(crawled_pages) AS pages
FROM pages WHERE url ILIKE '%nextjs.org%';
```

## 2. Site-name extraction — no junk strings

**CLI.** Inspect `site_name` for a few well-known brands:
```sql
SELECT url, site_name FROM pages
ORDER BY updated_at DESC LIMIT 5;
```
Expected: short 1–4-word brand names (`Next.js`, `Stripe`, `Uber Eats`),
never a concatenation like `Epic | ...With the patient at the heart...`.

## 3. External references

**Browser.** Submit a URL whose homepage links out to a well-known spec or
   upstream (e.g. `https://llm-text-generator.vercel.app` links to
   llmstxt.org; a React tutorial site usually links to react.dev).
**Browser.** Wait for completion, view the result.

**Pass**: the rendered output contains at least one entry whose
   URL is on a different hostname than the site you submitted. Links
   to bare origins render without a trailing `/` (e.g. `https://llmstxt.org`,
   not `https://llmstxt.org/`).

**CLI.** Sanity check — external refs should appear in `crawled_pages`:
```sql
SELECT
  jsonb_array_elements(crawled_pages)->>'url' AS url,
  jsonb_array_elements(crawled_pages)->>'section' AS section
FROM pages
WHERE url = '<the URL you submitted>';
```
A non-trivial fraction of crawls will have one or more external entries.
If none appear, the LLM may have judged none worth keeping — try a
site with more outbound links to validate.

## 4. Rate limiting — anon

**CLI.** Burn the anon bucket. Substitute a fresh unique URL each time so
   the cache doesn't short-circuit:
```bash
for i in 1 2 3 4; do
  curl -s -X POST http://localhost:3000/api/p \
    -H "Content-Type: application/json" \
    -d "{\"url\":\"https://example-$i.com\"}" \
    -w "HTTP %{http_code}\n" -o /dev/null
done
```
First 3 should return `201` or `200` (new or cached). 4th should
return `429` with a `Retry-After` header.

**CLI.** Confirm the 429 response includes `signInPrompt: true`:
```bash
curl -s -X POST http://localhost:3000/api/p \
  -H "Content-Type: application/json" \
  -d '{"url":"https://example-5.com"}' | jq
```

## 5. Sign-in + dashboard

**Browser.** Click "Sign in" from the landing page, complete GitHub or Google
   OAuth. Return to `/`.
**Browser.** **Auth-state stability**: the top-right nav shows "Dashboard +
   account menu" on the FIRST paint — no flash of "Sign in". (This
   was the server-side-auth fix.)
**Browser.** Click "Dashboard" → see your page history, newest at top.
**Browser.** Submit a URL already in your history → it jumps to the top
   (re-submission bumps `created_at`).
**Browser.** Click a row mid-crawl → you land on `/p/<uuid>` showing live progress,
   NOT bounced back to `/`. The row itself shows a "Refreshing…"
   label until completion.

## 6. Zip download

**Browser.** On `/dashboard`, click "Download" → receive a `.zip` containing one
   `.txt` per completed page in your history. Filenames are derived
   from the hostname (disambiguated with `-2`, `-3` suffixes on conflict).

## 7. Monitoring cron

In production the cron runs daily at 00:00 UTC (`"0 0 * * *"` in
`vercel.json`). Locally there's no scheduler — trigger it manually
with the Bearer token.

**CLI.** First check — seeds signatures, no re-crawl fires:
```bash
source .env
curl -s -H "Authorization: Bearer $CRON_SECRET" \
  http://localhost:3000/api/monitor | jq
# expect: {"checked":N,"changed":0,"swept":0,"recrawls":[],"errors":[]}
```

**CLI.** Force a change → expect re-crawls:
```sql
UPDATE pages SET content_signature = 'stale-sig' WHERE monitored = true;
```
```bash
curl -s -H "Authorization: Bearer $CRON_SECRET" \
  http://localhost:3000/api/monitor | jq
# expect: "changed":N > 0, "recrawls":["<uuid>", ...]
```
Watch the dev-server console for `[pipeline]` logs. Within ~30–60s the
dashboard row's label flips from "Refreshing…" to "Refreshed just now".

**CLI.** Sweep — retire stale pages:
```sql
UPDATE pages SET last_requested_at = NOW() - INTERVAL '6 days'
WHERE url = '<a URL you don't mind retiring>';
```
```bash
curl -s -H "Authorization: Bearer $CRON_SECRET" \
  http://localhost:3000/api/monitor | jq
# expect: "swept":1 (or more)
```

**CLI.** Auth negative check:
```bash
curl -i http://localhost:3000/api/monitor
# expect: HTTP/1.1 401 Unauthorized
```

## 8. SSRF refusal

**CLI.** Submit a private-range URL — expect a clean 4xx/scrubbed error,
   not a timeout or crash:
```bash
curl -s -X POST http://localhost:3000/api/p \
  -H "Content-Type: application/json" \
  -d '{"url":"http://127.0.0.1:3000"}' | jq
# expect: rate-limited (we're using anon) or a scrubbed "can't be crawled"
# error once you've burned the other tests' cache
```

Also verify a URL whose DNS resolves to a private IP is refused at the
crawl entry (`assertSafeUrl` rejects before any fetch):
```bash
curl -s -X POST http://localhost:3000/api/p \
  -H "Content-Type: application/json" \
  -d '{"url":"http://localhost"}' | jq
# expect: error message, no crawl job created
```

## 9. Negative / edge cases

**CLI.** Invalid URL → 400:
```bash
curl -s -X POST http://localhost:3000/api/p \
  -H "Content-Type: application/json" \
  -d '{"url":"not-a-url"}' -w "HTTP %{http_code}\n"
```

**CLI.** Too-long URL → 400:
```bash
curl -s -X POST http://localhost:3000/api/p \
  -H "Content-Type: application/json" \
  -d "{\"url\":\"https://example.com/$(head -c 3000 /dev/urandom | base64)\"}" \
  -w "HTTP %{http_code}\n"
```

**Browser.** Submit a site that 403s all bots (tough to predict; e.g. some
   WAF-heavy corporate sites). Expect a "This site blocked our crawler."
   error in the result page, not a hang.

**Browser.** Submit a site whose homepage is genuinely an SPA. Expect Puppeteer
   path to fire (dev-server logs should mention `spa` / rendered), and
   a non-trivial result.

---

## When a step fails

1. Check dev-server console output for the latest `[pipeline]`,
   `[monitor]`, or `[POST /api/p]` log lines.
2. For crawl failures, inspect the job row directly:
   ```sql
   SELECT id, status, progress, error FROM jobs
   WHERE page_url = '<url>' ORDER BY created_at DESC LIMIT 5;
   ```
3. For cache issues, delete the row and re-submit:
   ```sql
   DELETE FROM pages WHERE url = '<url>';
   ```
4. For auth issues, clear cookies (the Supabase session cookie is
   `sb-<project-ref>-auth-token`) and re-sign-in.
