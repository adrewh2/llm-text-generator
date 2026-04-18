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
import { randomUUID, timingSafeEqual } from "crypto"
import { waitUntil } from "@vercel/functions"
import {
  createJob,
  getMonitoredPages,
  recordMonitorCheck,
  sweepStaleMonitoredPages,
} from "@/lib/store"
import { detectChange } from "@/lib/crawler/monitor"
import { runCrawlPipeline } from "@/lib/crawler/pipeline"
import { debugLog } from "@/lib/log"

export const runtime = "nodejs"
export const maxDuration = 300

const STALE_MONITOR_DAYS = 5
// Politeness: space out repeated hits against the same host so the
// cron doesn't hammer a single origin with N back-to-back requests.
const SAME_HOST_DELAY_MS = 400

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
  // Track the last check time per host so N monitored pages on the
  // same origin aren't hit back-to-back.
  const lastHostHit = new Map<string, number>()

  for (const page of pages) {
    const host = hostOf(page.url)
    if (host) {
      const last = lastHostHit.get(host) ?? 0
      const wait = last + SAME_HOST_DELAY_MS - Date.now()
      if (wait > 0) await sleep(wait)
      lastHostHit.set(host, Date.now())
    }
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
      const message = err instanceof Error ? err.message : "unknown error"
      summary.errors.push({ url: page.url, error: message })
      debugLog("monitor", `${page.url}: ${message}`)
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
  const expectedHeader = `Bearer ${expected}`
  // timingSafeEqual requires equal-length buffers — bail first on
  // mismatched lengths so short attacker inputs don't throw.
  if (header.length !== expectedHeader.length) return false
  return timingSafeEqual(Buffer.from(header), Buffer.from(expectedHeader))
}

function hostOf(url: string): string | null {
  try { return new URL(url).host } catch { return null }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
