// Monitor cron. For each monitored page: re-compute a signature over
// sitemap + homepage, compare to the stored one, and enqueue a
// re-crawl if it drifted. Also sweeps stuck non-terminal jobs and
// retires URLs nobody has touched in the last N days.

import { NextRequest, NextResponse } from "next/server"
import { randomUUID, timingSafeEqual } from "crypto"
import {
  createJob,
  getActiveJobForUrl,
  getMonitoredPages,
  recordMonitorCheck,
  sweepStaleMonitoredPages,
  sweepStuckJobs,
} from "@/lib/store"
import { detectChange } from "@/lib/crawler/monitor"
import { enqueueCrawl } from "@/lib/jobQueue"
import { errorLog } from "@/lib/log"
import { consumeRateLimit } from "@/lib/rateLimit"
import { monitor, rateLimit } from "@/lib/config"

export const runtime = "nodejs"
export const maxDuration = 300

const { STALE_DAYS: STALE_MONITOR_DAYS, BATCH_SIZE: MONITOR_BATCH_SIZE, SAME_HOST_DELAY_MS, STUCK_JOB_AFTER_MS } = monitor

interface Summary {
  checked: number
  changed: number
  swept: number
  stuckFailed: number
  recrawls: string[]
  errors: Array<{ url: string; error: string }>
}

export async function GET(req: NextRequest) {
  if (!isAuthorized(req)) return new NextResponse("Unauthorized", { status: 401 })

  // Single global bucket. Each invocation can enqueue ~200 re-crawls
  // (batch size) × 4 Anthropic calls each ≈ 800 LLM calls of spend,
  // so a leaked CRON_SECRET is a serious amplification vector. Cap
  // well above the real cron cadence (1 / day) + manual testing
  // headroom, well below attacker-useful rates.
  const rate = await consumeRateLimit("cron:monitor", rateLimit.CRON_MONITOR)
  if (!rate.allowed) {
    return NextResponse.json(
      { error: "cron rate limit exceeded" },
      { status: 429, headers: { "Retry-After": String(rate.retryAfterSec) } },
    )
  }

  // Force-fail jobs stuck in a non-terminal status beyond the pipeline
  // budget + QStash retry window. Must run before getActiveJobForUrl
  // elsewhere starts treating these as legit in-flight work.
  const stuckFailed = await sweepStuckJobs(STUCK_JOB_AFTER_MS)

  // Then retire pages nobody has requested recently so we don't burn
  // cycles detecting changes on dormant URLs.
  const swept = await sweepStaleMonitoredPages(STALE_MONITOR_DAYS)

  const pages = await getMonitoredPages({ limit: MONITOR_BATCH_SIZE })
  const summary: Summary = { checked: 0, changed: 0, swept, stuckFailed, recrawls: [], errors: [] }

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
      errorLog("monitor", `${page.url}: ${message}`)
    }
  }

  return NextResponse.json(summary)
}

/**
 * Attach to an in-flight job if one exists — avoids a duplicate
 * crawl when a prior cron tick or a user submission is still
 * running. Otherwise create a new job and enqueue it.
 */
async function dispatchRecrawl(pageUrl: string): Promise<string> {
  const active = await getActiveJobForUrl(pageUrl)
  if (active) return active.jobId

  const jobId = randomUUID()
  await createJob(jobId, pageUrl)
  await enqueueCrawl(jobId, pageUrl)
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
