import { NextRequest, NextResponse } from "next/server"
import { bumpPageRequest, getJob } from "@/lib/store"

export const runtime = "nodejs"

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const job = await getJob(id)
  if (!job) return NextResponse.json({ error: "Not found" }, { status: 404 })

  // Viewing a page (including polling a mid-flight job) counts as
  // "active use" of the URL — bump the request timestamp so the
  // monitor sweeper keeps it. Skip only on `failed` — no point
  // extending a page's monitored lifetime on failures.
  // NOTE: we deliberately do NOT attach the page to the viewer's
  // dashboard history here. History is owned by the user who submitted
  // the URL via the landing form (see POST /api/p). Otherwise a
  // stranger's UUID, once shared, would quietly land in any viewer's
  // dashboard.
  if (job.status !== "failed") {
    await bumpPageRequest(job.url)
  }

  return NextResponse.json({
    ...job,
    error: job.error ? scrubError(job.error) : undefined,
    createdAt: job.createdAt.toISOString(),
    updatedAt: job.updatedAt.toISOString(),
  })
}

/**
 * Map internal pipeline errors to short user-facing messages. Prevents
 * us from leaking SSRF internals (resolved IPs, path hints) or stack
 * details that would signal "that attack got through to the crawler".
 */
function scrubError(raw: string): string {
  const lower = raw.toLowerCase()
  if (lower.startsWith("unsafe url") || lower.includes("forbidden ip"))
    return "This URL can't be crawled."
  if (lower.includes("http 403") || lower.includes("bot challenge"))
    return "This site blocked our crawler."
  if (lower.startsWith("http ")) return "The site returned an error."
  if (lower.includes("timeout") || lower.includes("timed out"))
    return "The site took too long to respond."
  if (lower.includes("dns")) return "Couldn't resolve that domain."
  if (lower.includes("browser render failed")) return "We couldn't render this site."
  if (lower.includes("exceeded time budget")) return "Crawl took longer than our budget allows."
  return "Couldn't generate a result for this site."
}
