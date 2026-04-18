// Monitoring cron entrypoint.
//
// Invoked on a schedule (see vercel.json). For each monitored page, we:
//   1. Compute a fresh signature over sitemap + homepage.
//   2. Compare to the stored signature.
//   3. On mismatch, create a new job row and dispatch a full re-crawl.
//
// The detection phase is I/O-light and runs inline. The re-crawl phase
// is isolated behind dispatchRecrawl() — that is the seam a future
// queue (Vercel Queues, Inngest) would replace so individual re-crawls
// become their own durable invocations. For now we fan out via
// waitUntil within this same function, which is fine up to a few dozen
// concurrent changed pages.

import { NextRequest, NextResponse } from "next/server"
import { randomUUID } from "crypto"
import { waitUntil } from "@vercel/functions"
import {
  createJob,
  getMonitoredPages,
  recordMonitorCheck,
  sweepStaleMonitoredPages,
} from "@/lib/store"
import { detectChange } from "@/lib/crawler/monitor"
import { runCrawlPipeline } from "@/lib/crawler/pipeline"

export const runtime = "nodejs"
export const maxDuration = 300

const STALE_MONITOR_DAYS = 5

interface Summary {
  checked: number
  changed: number
  swept: number
  recrawls: string[]
  errors: Array<{ url: string; error: string }>
}

export async function GET(req: NextRequest) {
  if (!isAuthorized(req)) return new NextResponse("Unauthorized", { status: 401 })

  // First, retire pages nobody has requested recently so we don't burn
  // cycles detecting changes on dormant URLs.
  const swept = await sweepStaleMonitoredPages(STALE_MONITOR_DAYS)

  const pages = await getMonitoredPages()
  const summary: Summary = { checked: 0, changed: 0, swept, recrawls: [], errors: [] }

  // Sequential detection keeps memory flat and is polite to target
  // domains. The bottleneck is target-site response time, not CPU.
  for (const page of pages) {
    try {
      const { changed, newSignature } = await detectChange(page.url, page.contentSignature)
      await recordMonitorCheck(page.url, newSignature)
      summary.checked++

      if (changed) {
        summary.changed++
        const jobId = await dispatchRecrawl(page.url)
        summary.recrawls.push(jobId)
      }
    } catch (err: unknown) {
      summary.errors.push({
        url: page.url,
        error: err instanceof Error ? err.message : "unknown error",
      })
    }
  }

  return NextResponse.json(summary)
}

/**
 * Queue-boundary: create a job row and spawn the crawl pipeline.
 * Today this runs in-process via waitUntil. Replacing the body with
 * an enqueue call (Vercel Queues / Inngest) is where scaling goes.
 */
async function dispatchRecrawl(pageUrl: string): Promise<string> {
  const jobId = randomUUID()
  await createJob(jobId, pageUrl)
  waitUntil(runCrawlPipeline(jobId, pageUrl))
  return jobId
}

function isAuthorized(req: NextRequest): boolean {
  const expected = process.env.CRON_SECRET
  if (!expected) return false // fail closed if the secret isn't configured
  const header = req.headers.get("authorization") || ""
  return header === `Bearer ${expected}`
}
