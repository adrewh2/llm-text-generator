import { NextRequest, NextResponse } from "next/server"
import { getJob, upsertUserRequest } from "@/lib/store"
import { createClient } from "@/lib/supabase/server"

export const runtime = "nodejs"

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const job = await getJob(id)
  if (!job) return NextResponse.json({ error: "Not found" }, { status: 404 })

  // When a signed-in user views a completed result, record it in their history
  if (job.status === "complete" || job.status === "partial") {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (user) await upsertUserRequest(user.id, job.url)
  }

  return NextResponse.json({
    ...job,
    createdAt: job.createdAt.toISOString(),
    updatedAt: job.updatedAt.toISOString(),
  })
}
