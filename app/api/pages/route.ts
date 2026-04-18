import { NextRequest, NextResponse } from "next/server"
import { getUserPages } from "@/lib/store"
import { createClient } from "@/lib/supabase/server"

export const runtime = "nodejs"

const DEFAULT_LIMIT = 20
const MAX_LIMIT = 50

export async function GET(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return new NextResponse(null, { status: 401 })

  const params = new URL(req.url).searchParams
  const offset = Math.max(0, parseInt(params.get("offset") ?? "0", 10) || 0)
  const rawLimit = parseInt(params.get("limit") ?? `${DEFAULT_LIMIT}`, 10) || DEFAULT_LIMIT
  const limit = Math.min(MAX_LIMIT, Math.max(1, rawLimit))

  // Ask for one more than requested so we can tell the client whether
  // another page exists without a separate count query.
  const pages = await getUserPages(user.id, { offset, limit: limit + 1 })
  const hasMore = pages.length > limit
  const trimmed = hasMore ? pages.slice(0, limit) : pages

  return NextResponse.json({
    pages: trimmed.map((p) => ({
      ...p,
      requestedAt: p.requestedAt.toISOString(),
      lastCheckedAt: p.lastCheckedAt ? p.lastCheckedAt.toISOString() : null,
    })),
    hasMore,
  })
}
