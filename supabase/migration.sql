-- Full schema as applied to the Supabase project.
-- This file reflects the actual database state — do not re-run it blindly.

-- pages: one globally-shared result per URL
--
-- `id` is the user-facing identifier. The app routes every page view
-- through /p/{id} where id is this UUID — one page, one URL, across
-- every re-crawl. `url` stays PRIMARY KEY because it's the canonical
-- dedup key for the crawl pipeline and the FK target for jobs +
-- user_requests.
CREATE TABLE pages (
  url TEXT PRIMARY KEY,
  id UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  result TEXT,                   -- nullable until job completes
  site_name TEXT,
  genre TEXT,
  crawled_pages JSONB,
  -- Monitoring is a system invariant: every page is monitored by
  -- default. The cron at /api/monitor re-computes a signature over the
  -- site's sitemap + homepage and triggers a re-crawl on mismatch.
  -- `last_requested_at` is bumped on every /api/p hit; the cron
  -- sweeper disables monitoring on pages not requested in the last
  -- 5 days.
  monitored BOOLEAN NOT NULL DEFAULT true,
  last_checked_at TIMESTAMPTZ,
  last_requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  content_signature TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_pages_monitored ON pages(monitored) WHERE monitored = true;
CREATE INDEX idx_pages_last_requested_at ON pages(last_requested_at);

-- jobs: one row per crawl execution, linked to a page
CREATE TABLE jobs (
  id UUID PRIMARY KEY,
  page_url TEXT NOT NULL REFERENCES pages(url) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending',
  progress JSONB NOT NULL DEFAULT '{"discovered":0,"crawled":0,"failed":0}',
  site_name TEXT,
  genre TEXT,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Guard against typos in client code silently writing an unexpected
  -- status value and breaking the pipeline's state machine.
  CONSTRAINT jobs_status_check CHECK (status IN (
    'pending', 'crawling', 'enriching', 'scoring',
    'assembling', 'complete', 'partial', 'failed'
  ))
);

-- user_requests: tracks which pages each signed-in user has visited
CREATE TABLE user_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  page_url TEXT NOT NULL REFERENCES pages(url) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(user_id, page_url)
);

-- Backs the dashboard's paginated "my pages" query:
--   WHERE user_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?
CREATE INDEX idx_user_requests_user_created
  ON user_requests(user_id, created_at DESC);

-- Backs the dashboard's "latest job per page" lookup:
--   WHERE page_url IN (?) ORDER BY created_at DESC
-- The dashboard surfaces the newest job's status (any status) so
-- monitor re-crawls render as "Refreshing…" even while pages.result
-- still holds the last terminal output. The `status` column is
-- carried in the index for covering-read purposes.
CREATE INDEX idx_jobs_page_status_created
  ON jobs(page_url, status, created_at DESC);

-- RLS is enabled on every table. All app reads/writes go through server
-- API routes using the service-role key, which bypasses RLS.
--
-- No anon-accessible policies on `pages` or `jobs`: the anon key is in
-- every browser bundle (NEXT_PUBLIC_*), so "anon can do X" means "anyone
-- on the internet can do X by hitting Supabase directly, bypassing our
-- API's rate limiter and CDN cache." The browser never queries these
-- tables directly — it goes through our API routes — so we leave anon
-- with no data-access grants. RLS's default-deny then blocks direct-to-
-- Supabase enumeration with the leaked anon key.
ALTER TABLE pages          ENABLE ROW LEVEL SECURITY;
ALTER TABLE jobs           ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_requests  ENABLE ROW LEVEL SECURITY;

-- A user may only touch rows that belong to them. The one explicit
-- policy we need — it's what stops one user from reading another user's
-- history when signed in with the anon key.
CREATE POLICY user_requests_own ON user_requests
  FOR ALL
  USING      (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);
