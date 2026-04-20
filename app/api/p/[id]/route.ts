import { NextRequest, NextResponse } from "next/server"
import { bumpPageRequest, getPageById, getPageStatusById } from "@/lib/store"
import { scrubError } from "./scrubError"

export const runtime = "nodejs"

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  // `id` is the pages.id UUID (user-facing, stable across re-crawls).
  // Start with the lightweight status query — no result / no
  // crawled_pages. That's all the UI needs for every in-flight poll,
  // and it avoids pulling the previous terminal value along when a
  // monitor re-crawl is in flight (UI would drop it anyway).
  const status = await getPageStatusById(id)
  if (!status) return NextResponse.json({ error: "Not found" }, { status: 404 })

  // Terminal status → fetch the payload (result + crawled_pages) in a
  // second query. Happens at most once per page per CDN-cache window,
  // since terminal responses are cached downstream; in-flight polls
  // never pay for it.
  const isTerminalStatus = status.status === "complete" || status.status === "partial"
  const job = isTerminalStatus ? ((await getPageById(id)) ?? status) : status

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
      lastCheckedAt: job.lastCheckedAt?.toISOString(),
    },
    { headers: { "Cache-Control": cacheControl } },
  )
}
