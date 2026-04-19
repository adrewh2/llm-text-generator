import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"

const DEFAULT_NEXT = "/"

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
  // Reject control / whitespace chars — browsers differ on how they
  // normalise `/\t//evil.com` and similar, so sidestep the spec
  // variance entirely.
  if (/[\x00-\x1f\s]/.test(next)) return DEFAULT_NEXT
  // Reject percent-encoded path separators — an intermediate proxy
  // can normalise `/%2f%2fevil.com` back to `//evil.com` before the
  // browser sees it.
  if (/%2f|%5c/i.test(next)) return DEFAULT_NEXT
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
