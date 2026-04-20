-- Applied to production Supabase: 2026-04-20
--
-- Drops anon SELECT on `pages` and `jobs` so the browser-bundled anon
-- key can no longer enumerate either table by hitting Supabase's REST
-- endpoint directly. App reads continue to work unchanged because they
-- flow through the server-side store (service-role key, bypasses RLS).
--
-- Paste into Supabase Dashboard → SQL Editor → Run. Idempotent (uses
-- IF EXISTS).

DROP POLICY IF EXISTS pages_public_read ON pages;
DROP POLICY IF EXISTS jobs_public_read  ON jobs;

-- Verify: these should each return zero rows.
-- SELECT * FROM pg_policies WHERE tablename = 'pages' AND policyname = 'pages_public_read';
-- SELECT * FROM pg_policies WHERE tablename = 'jobs'  AND policyname = 'jobs_public_read';
