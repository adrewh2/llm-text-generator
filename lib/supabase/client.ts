import { createBrowserClient } from "@supabase/ssr"

// These `NEXT_PUBLIC_*` vars are inlined at build time; a dynamic
// runtime helper like requireEnv won't work here because Next only
// inlines literal property accesses. If either is missing at build
// time the bundle contains `undefined`, and createBrowserClient will
// reject with a clear "Invalid URL" — no cryptic crash to dig through.
export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  )
}
