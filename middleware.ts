import { createServerClient } from "@supabase/ssr"
import { NextResponse, type NextRequest } from "next/server"
import { requireEnv } from "@/lib/env"

export async function middleware(request: NextRequest) {
  let supabaseResponse = NextResponse.next({ request })

  const supabase = createServerClient(
    requireEnv("NEXT_PUBLIC_SUPABASE_URL"),
    requireEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY"),
    {
      cookies: {
        getAll() { return request.cookies.getAll() },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value))
          supabaseResponse = NextResponse.next({ request })
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options)
          )
        },
      },
    }
  )

  const { data: { user } } = await supabase.auth.getUser()

  // Protect dashboard — redirect to login if not authenticated
  if (!user && request.nextUrl.pathname.startsWith("/dashboard")) {
    const url = request.nextUrl.clone()
    url.pathname = "/login"
    const redirect = NextResponse.redirect(url)
    // Carry queued Supabase cookies onto the redirect so the refreshed
    // session survives (per Supabase SSR guide).
    supabaseResponse.cookies.getAll().forEach((c) => redirect.cookies.set(c))
    return redirect
  }

  return supabaseResponse
}

export const config = {
  // Scope: only routes that actually need the session cookie kept
  // fresh. Public routes (`/`, `/p/{id}`, `/jobs/{id}`) skip the
  // middleware entirely so anon viewers don't pay for a Supabase
  // `getUser()` roundtrip the anon-readable page doesn't use.
  //
  // Covered:
  //   - /dashboard/*   — server-gated to signed-in users
  //   - /login         — reads session to auto-redirect if signed in
  //   - /auth/*        — OAuth callback exchanges code for session
  //   - /api/*         — auth-gated endpoints (submit, history,
  //                      download, request). /api/p/{id} and
  //                      /api/jobs/{id} GETs are public but still
  //                      run through Supabase for other reasons;
  //                      the small extra round-trip here is cheaper
  //                      than excluding them precisely.
  matcher: [
    "/dashboard/:path*",
    "/login",
    "/auth/:path*",
    "/api/:path*",
  ],
}
