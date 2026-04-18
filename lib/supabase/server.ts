import { createServerClient } from "@supabase/ssr"
import { cookies } from "next/headers"
import { requireEnv } from "@/lib/env"

export async function createClient() {
  const cookieStore = await cookies()
  return createServerClient(
    requireEnv("SUPABASE_URL"),
    requireEnv("SUPABASE_ANON_KEY"),
    {
      cookies: {
        getAll() { return cookieStore.getAll() },
        setAll(cookiesToSet) {
          // Next throws when setting cookies outside a Server Action /
          // Route Handler (e.g. inside a Server Component render). That's
          // expected; the session-refresh path re-runs in middleware.
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options),
            )
          } catch {
            // no-op — see comment above
          }
        },
      },
    },
  )
}
