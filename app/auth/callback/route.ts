import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"

const DEFAULT_NEXT = "/dashboard"

/**
 * Only accept same-origin absolute paths. `//evil.com` is a
 * scheme-relative URL that browsers treat as a redirect to evil.com —
 * the classic open-redirect footgun.
 */
function sanitizeNext(next: string | null): string {
  if (!next) return DEFAULT_NEXT
  if (!next.startsWith("/")) return DEFAULT_NEXT
  if (next.startsWith("//")) return DEFAULT_NEXT
  if (next.startsWith("/\\")) return DEFAULT_NEXT // IE/old-browser trick
  return next
}

export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url)
  const code = searchParams.get("code")
  const next = sanitizeNext(searchParams.get("next"))

  if (code) {
    const supabase = await createClient()
    const { error } = await supabase.auth.exchangeCodeForSession(code)
    if (!error) {
      return NextResponse.redirect(`${origin}${next}`)
    }
  }

  return NextResponse.redirect(`${origin}/login?error=auth`)
}
