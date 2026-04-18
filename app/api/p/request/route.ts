import { NextRequest, NextResponse } from "next/server"
import { removeUserRequest } from "@/lib/store"
import { createClient } from "@/lib/supabase/server"

export const runtime = "nodejs"

export async function DELETE(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return new NextResponse(null, { status: 401 })

  const pageUrl = new URL(req.url).searchParams.get("pageUrl")
  if (!pageUrl) return NextResponse.json({ error: "pageUrl required" }, { status: 400 })

  await removeUserRequest(user.id, pageUrl)
  return new NextResponse(null, { status: 204 })
}
