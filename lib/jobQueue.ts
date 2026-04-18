// Crawl-job queue. QStash in production (durable retry via signed
// callback to /api/worker/crawl); `waitUntil(runCrawlPipeline)` as a
// local-dev fallback when QSTASH_TOKEN isn't set. Publish errors
// fall through to the in-process path so a flaky QStash doesn't
// drop the crawl entirely.

import { Client } from "@upstash/qstash"
import { waitUntil } from "@vercel/functions"
import { runCrawlPipeline } from "./crawler/pipeline"
import { crawler } from "./config"
import { debugLog } from "./log"

const qstash: Client | null = (() => {
  if (!process.env.QSTASH_TOKEN) return null
  // QSTASH_URL is region-specific. SDK defaults to eu-central-1 and
  // silently 404s for accounts hosted elsewhere (no exception, no
  // visible error — message never lands).
  if (!process.env.QSTASH_URL) {
    console.warn(
      "[jobQueue] QSTASH_TOKEN is set but QSTASH_URL is not — " +
      "publishes will go to the SDK default (eu-central-1) and " +
      "may silently fail if the account is hosted elsewhere.",
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

export async function enqueueCrawl(jobId: string, url: string): Promise<void> {
  const workerUrl = resolveWorkerUrl()
  const branch =
    qstash && workerUrl ? "qstash" :
    !qstash ? "fallback:no-token" :
    "fallback:no-worker-url"
  // Operational signal: a spike of `fallback:*` in prod means QStash
  // state has drifted.
  console.info(`[enqueueCrawl] branch=${branch} jobId=${jobId}`)

  if (qstash && workerUrl) {
    try {
      await qstash.publishJSON({
        url: workerUrl,
        body: { jobId, url },
        retries: 3,
        // Match the pipeline budget; the pipeline self-terminates at
        // that point and writes a "failed" state.
        timeout: Math.ceil(crawler.PIPELINE_BUDGET_MS / 1000),
      })
      return
    } catch (err) {
      debugLog("jobQueue.publish", err)
      // Fall through to the in-process path below.
    }
  }
  waitUntil(runCrawlPipeline(jobId, url))
}
