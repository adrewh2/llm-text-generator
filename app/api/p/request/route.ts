import { NextRequest, NextResponse } from "next/server"
import { getPageByUrl, hasUserRequest, removeUserRequest, upsertUserRequest } from "@/lib/store"
import { isAllowedOrigin } from "@/lib/upstash/rateLimit"
import { createClient } from "@/lib/supabase/server"

export const runtime = "nodejs"

/**
 * GET /api/p/request?pageUrl=…
 * Tells the caller whether the signed-in user already has this URL
 * in their history. Powers the "Add to dashboard" affordance on the
 * result page — we only show the button when the URL isn't already
 * saved.
 *
 * Not origin-checked (read-only, side-effect-free). Auth-gated;
 * anon callers get a plain `false` so the UI just hides the button.
 */
export async function GET(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ inHistory: false })

  const pageUrl = new URL(req.url).searchParams.get("pageUrl")
  if (!pageUrl) return NextResponse.json({ error: "pageUrl required" }, { status: 400 })

  const inHistory = await hasUserRequest(user.id, pageUrl)
  return NextResponse.json({ inHistory })
}

/**
 * POST /api/p/request?pageUrl=…
 * Upsert a user_requests row for the signed-in user. Used when a
 * signed-in user views a publicly-shared result URL and wants to
 * save it to their dashboard without re-triggering a crawl.
 *
 * Rejects unknown URLs with 404 — the upsert path in POST /api/p
 * is the only way a URL enters the `pages` table, so writing here
 * to a URL that was never crawled would orphan the row under the FK
 * cascade. Origin-checked like DELETE.
 */
export async function POST(req: NextRequest) {
  if (!isAllowedOrigin(req)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return new NextResponse(null, { status: 401 })

  const pageUrl = new URL(req.url).searchParams.get("pageUrl")
  if (!pageUrl) return NextResponse.json({ error: "pageUrl required" }, { status: 400 })

  const page = await getPageByUrl(pageUrl)
  if (!page) return NextResponse.json({ error: "Unknown URL" }, { status: 404 })

  await upsertUserRequest(user.id, pageUrl)
  return new NextResponse(null, { status: 201 })
}

export async function DELETE(req: NextRequest) {
  if (!isAllowedOrigin(req)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return new NextResponse(null, { status: 401 })

  const pageUrl = new URL(req.url).searchParams.get("pageUrl")
  if (!pageUrl) return NextResponse.json({ error: "pageUrl required" }, { status: 400 })

  await removeUserRequest(user.id, pageUrl)
  return new NextResponse(null, { status: 204 })
}
