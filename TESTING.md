# Monitoring — Local Test Playbook

Takes ~2 minutes. Assumes `.env` has `CRON_SECRET` set.

Monitoring is **always on** — every generated page is monitored by default.
The cron (hourly in prod, manually triggerable locally) does three things:

1. **Sweeps** pages not requested in the last 5 days → turns monitoring off.
2. **Computes a fresh signature** over each monitored page's sitemap + homepage.
3. **Dispatches a full re-crawl** when the signature differs from the stored one.

## 1. Start dev server

```bash
npm run dev
```

## 2. Generate a page

- Go to http://localhost:3000, sign in, generate a URL (e.g. `https://nextjs.org`).
- The page's `monitored` flag is set to `true` by the default on insert.
- On `/dashboard`, each row shows a small "Awaiting check" label until the cron has run.

## 3. Manually trigger the cron

```bash
source .env
curl -s -H "Authorization: Bearer $CRON_SECRET" http://localhost:3000/api/monitor | jq
# expect: {"checked":N,"changed":0,"swept":0,"recrawls":[],"errors":[]}
```

First cron seeds a signature for each monitored page (no re-crawl fires — first-check grace). Refresh the dashboard and the label should read "Checked <1 min ago".

## 4. Force a change → expect a re-crawl

Corrupt the signature to simulate drift:

```sql
-- Run via Supabase SQL editor or MCP
UPDATE pages SET content_signature = 'stale-sig' WHERE monitored = true;
```

Then re-hit the cron:

```bash
curl -s -H "Authorization: Bearer $CRON_SECRET" http://localhost:3000/api/monitor | jq
# expect: {"checked":N,"changed":N,"swept":0,"recrawls":["<uuid>", ...],"errors":[]}
```

A new job row appears per changed page and `runCrawlPipeline` fires in the background.
Watch the dev-server console for `[pipeline]` logs; in ~30–60s the dashboard should show
a fresh "Checked just now" and the new `/p/<uuid>` renders the updated result.

## 5. Sweep check

Backdate a page's last-request timestamp so the sweep fires:

```sql
UPDATE pages SET last_requested_at = NOW() - INTERVAL '6 days'
WHERE url = 'https://example.com/';  -- a URL you don't mind retiring
```

Re-hit the cron:

```bash
curl -s -H "Authorization: Bearer $CRON_SECRET" http://localhost:3000/api/monitor | jq
# expect: "swept":1, and that URL is no longer in getMonitoredPages() — its label
# disappears from the dashboard.
```

## 6. Negative checks

```bash
# Cron without auth — expect 401
curl -i http://localhost:3000/api/monitor
```
