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

  // Terminal success → long-lived edge cache; `updateJob` revalidates
  // the path on the next re-crawl. `failed` is kept short because it
  // often reflects a transient condition (DNS blip, bot challenge, a
  // site we haven't yet added a workaround for) — we'd rather absorb
  // a retry hot path than pin someone's broken result for a day.
  const cacheControl =
    job.status === "complete" || job.status === "partial"
      ? "public, s-maxage=86400, stale-while-revalidate=604800"
      : job.status === "failed"
      ? "public, s-maxage=60"
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
