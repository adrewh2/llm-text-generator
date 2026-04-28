// Crawl-job queue. QStash in production (durable retry via signed
// callback to /api/worker/crawl); `waitUntil(runCrawlPipeline)` as a
// local-dev fallback when QSTASH_TOKEN isn't set. Publish errors
// fall through to the in-process path so a flaky QStash doesn't
// drop the crawl entirely.

import { Client } from "@upstash/qstash"
import { waitUntil } from "@vercel/functions"
import { runCrawlPipeline } from "../crawler/pipeline"
import { crawler } from "../config"
import { debugLog, errorLog } from "../log"

const qstash: Client | null = (() => {
  if (!process.env.QSTASH_TOKEN) return null
  // QSTASH_URL is region-specific. SDK defaults to eu-central-1 and
  // silently 404s for accounts hosted elsewhere (no exception, no
  // visible error — message never lands). Route through errorLog so
  // Sentry groups the misconfig as an issue — otherwise it buries in
  // the Vercel log feed and durable queuing is silently disabled.
  if (!process.env.QSTASH_URL) {
    errorLog(
      "jobQueue.clientInit",
      "QSTASH_TOKEN is set but QSTASH_URL is not — publishes will go to the SDK default (eu-central-1) and may silently fail if the account is hosted elsewhere.",
    )
  }
  try {
    return new Client({
      token: process.env.QSTASH_TOKEN,
      baseUrl: process.env.QSTASH_URL,
    })
  } catch (err) {
    debugLog("jobQueue.clientInit", err)
    return null
  }
})()

/**
 * Resolve the worker URL for QStash callbacks. `QSTASH_WORKER_URL`
 * overrides (handy for ngrok tunnels). Otherwise prefer
 * `VERCEL_PROJECT_PRODUCTION_URL` — the per-deployment `VERCEL_URL`
 * is gated by Deployment Protection and would 401 the callback.
 * Returns null off-Vercel so `enqueueCrawl` drops to the in-process
 * `waitUntil` fallback.
 */
function resolveWorkerUrl(): string | null {
  if (process.env.QSTASH_WORKER_URL) return process.env.QSTASH_WORKER_URL
  if (process.env.VERCEL === "1") {
    const host =
      process.env.VERCEL_PROJECT_PRODUCTION_URL || process.env.VERCEL_URL
    if (host) return `https://${host}/api/worker/crawl`
  }
  return null
}

/**
 * Enqueue a crawl job for delivery to the worker.
 *
 * `delaySeconds` (default 0) tells QStash to defer delivery by that
 * many seconds. Used by the monitor cron to stagger N drifted URLs
 * over time instead of firing all workers in one minute and burning
 * the Anthropic RPM budget. Falls through to in-process `waitUntil`
 * for local dev (where the delay is moot — single-job processing).
 */
export async function enqueueCrawl(
  jobId: string,
  url: string,
  delaySeconds = 0,
): Promise<void> {
  const workerUrl = resolveWorkerUrl()
  const branch =
    qstash && workerUrl ? "qstash" :
    !qstash ? "fallback:no-token" :
    "fallback:no-worker-url"
  // Operational signal: a spike of `fallback:*` in prod means QStash
  // state has drifted. Delay is logged separately so an unexpectedly-
  // large stagger value (cron tick miscounted) is visible.
  console.info(
    `[enqueueCrawl] branch=${branch} jobId=${jobId}` +
    (delaySeconds > 0 ? ` delaySec=${delaySeconds}` : ""),
  )

  if (qstash && workerUrl) {
    try {
      await qstash.publishJSON({
        url: workerUrl,
        body: { jobId, url },
        retries: 3,
        // Match the pipeline budget; the pipeline self-terminates at
        // that point and writes a "failed" state.
        timeout: Math.ceil(crawler.PIPELINE_BUDGET_MS / 1000),
        // QStash holds the message and only invokes the worker after
        // this many seconds. 0 means deliver immediately (the user-
        // submission path); cron callers pass a per-job stagger to
        // smooth Anthropic RPM consumption.
        ...(delaySeconds > 0 ? { delay: delaySeconds } : {}),
      })
      return
    } catch (err) {
      debugLog("jobQueue.publish", err)
      // Fall through to the in-process path below.
    }
  }
  waitUntil(runCrawlPipeline(jobId, url))
}
