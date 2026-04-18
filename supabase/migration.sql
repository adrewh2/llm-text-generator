-- Full schema as applied to the Supabase project.
-- This file reflects the actual database state — do not re-run it blindly.

-- pages: one globally-shared result per URL
CREATE TABLE pages (
  url TEXT PRIMARY KEY,
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
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- user_requests: tracks which pages each signed-in user has visited
CREATE TABLE user_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  page_url TEXT NOT NULL REFERENCES pages(url) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(user_id, page_url)
);

-- RLS is enabled on every table. All app reads/writes go through server
-- API routes using the service-role key, which bypasses RLS. The
-- policies below define what anon + authenticated clients could do if
-- they ever queried Supabase directly (e.g. via the leaked anon key).
ALTER TABLE pages          ENABLE ROW LEVEL SECURITY;
ALTER TABLE jobs           ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_requests  ENABLE ROW LEVEL SECURITY;

-- pages + jobs are globally shared and safe to expose as read-only: the
-- llms.txt output is the whole point of the product, and finding a job
-- requires already knowing its UUID.
CREATE POLICY pages_public_read ON pages FOR SELECT USING (true);
CREATE POLICY jobs_public_read  ON jobs  FOR SELECT USING (true);

-- A user may only touch rows that belong to them. This is the critical
-- policy — it's what stops one user from reading another user's history.
CREATE POLICY user_requests_own ON user_requests
  FOR ALL
  USING      (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);
