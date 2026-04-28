import { NextRequest, NextResponse } from "next/server"
import { getJobById } from "@/lib/store"
import { scrubError } from "@/app/api/p/[id]/scrubError"

export const runtime = "nodejs"

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  const job = await getJobById(id)
  if (!job) return NextResponse.json({ error: "Not found" }, { status: 404 })

  // Terminal jobs are short-cached at the edge; the /jobs/{id} client
  // will redirect away on its next poll, so a brief stale read is
  // harmless. In-flight jobs must hit the function every poll.
  const isTerminal =
    job.status === "complete" || job.status === "partial" || job.status === "failed"
  const cacheControl = isTerminal ? "public, s-maxage=60" : "no-store"

  return NextResponse.json(
    {
      id: job.jobId,
      pageId: job.pageId,
      pageUrl: job.pageUrl,
      status: job.status,
      progress: job.progress,
      error: job.error ? scrubError(job.error) : null,
      createdAt: job.createdAt.toISOString(),
      updatedAt: job.updatedAt.toISOString(),
    },
    { headers: { "Cache-Control": cacheControl } },
  )
}
