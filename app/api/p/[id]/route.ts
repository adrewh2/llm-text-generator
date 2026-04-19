import { NextRequest, NextResponse } from "next/server"
import { bumpPageRequest, getPageById } from "@/lib/store"
import { scrubError } from "./scrubError"

export const runtime = "nodejs"

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  // `id` is the pages.id UUID (user-facing, stable across re-crawls) —
  // getPageById joins the latest job for status so an in-flight
  // monitor re-crawl surfaces "Refreshing…" even when the cached
  // page.result is still the previous terminal output.
  const job = await getPageById(id)
  if (!job) return NextResponse.json({ error: "Not found" }, { status: 404 })

  // Count a view as "active use" so the monitor sweeper keeps the page.
  // Fire-and-forget — this write doesn't gate the response. Awaiting
  // it added a DB roundtrip to every view latency for no user benefit;
  // the sweeper is eventually-consistent.
  if (job.status !== "failed") {
    bumpPageRequest(job.url).catch(() => {})
  }

  // Terminal jobs are immutable until the next re-crawl, at which point
  // updateJob() revalidates the path. The TTL is a safety net.
  const isTerminal =
    job.status === "complete" || job.status === "partial" || job.status === "failed"
  const cacheControl = isTerminal
    ? "public, s-maxage=86400, stale-while-revalidate=604800"
    : "no-store"

  return NextResponse.json(
    {
      ...job,
      error: job.error ? scrubError(job.error) : undefined,
      createdAt: job.createdAt.toISOString(),
      updatedAt: job.updatedAt.toISOString(),
    },
    { headers: { "Cache-Control": cacheControl } },
  )
}
