-- Full schema as applied to the Supabase project.
-- This file reflects the actual database state — do not re-run it blindly.

-- pages: one globally-shared result per URL
CREATE TABLE pages (
  url TEXT PRIMARY KEY,
  result TEXT,                   -- nullable until job completes
  site_name TEXT,
  genre TEXT,
  crawled_pages JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- RLS disabled — all writes go through server-side API routes

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
-- RLS disabled — all writes go through server-side API routes

-- user_requests: tracks which pages each signed-in user has visited
CREATE TABLE user_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  page_url TEXT NOT NULL REFERENCES pages(url) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(user_id, page_url)
);

ALTER TABLE user_requests ENABLE ROW LEVEL SECURITY;
CREATE POLICY "user_requests_own" ON user_requests
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);
