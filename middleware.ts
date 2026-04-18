import { createServerClient } from "@supabase/ssr"
import { NextResponse, type NextRequest } from "next/server"
import { requireEnv } from "@/lib/env"

export async function middleware(request: NextRequest) {
  let supabaseResponse = NextResponse.next({ request })

  const supabase = createServerClient(
    requireEnv("SUPABASE_URL"),
    requireEnv("SUPABASE_ANON_KEY"),
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
    // Carry over any cookies Supabase queued on supabaseResponse during
    // the getUser() session-refresh so the refreshed session cookie
    // survives the redirect (per Supabase's SSR guide).
    supabaseResponse.cookies.getAll().forEach((c) => redirect.cookies.set(c))
    return redirect
  }

  return supabaseResponse
}

export const config = {
  // Run on every non-static request so the Supabase session cookie is
  // refreshed on API routes too (per Supabase's SSR guidance). Without
  // this, supabase.auth.getUser() may return null inside POST /api/p
  // even when the user is signed in.
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|css|js)$).*)",
  ],
}
