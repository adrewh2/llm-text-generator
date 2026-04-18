// Durable crawl-job queue.
//
// Two paths, selected at call time:
//
//   - QStash (preferred in production). When `QSTASH_TOKEN` is set
//     and a worker URL is resolvable, `enqueueCrawl` publishes the
//     job to QStash, which then POSTs to our
//     `/api/worker/crawl` endpoint with a signed request. QStash
//     owns retry / backoff — if the worker returns non-2xx (or
//     times out) the delivery is re-attempted. The pipeline runs
//     synchronously inside the worker so a mid-pipeline crash is an
//     actual retry, not a stuck row.
//
//   - `waitUntil(runCrawlPipeline(...))` (fallback). Used when the
//     QStash env vars aren't set — e.g. `npm run dev` without a
//     public callback URL. Matches the pre-queue behaviour: crawl
//     runs in the caller's own Fluid Compute instance, no retry on
//     failure.
//
// Falls back to `waitUntil` whenever the publish step throws — a
// QStash outage shouldn't drop the crawl entirely, better to try
// the in-process path than silently discard the work.

import { Client } from "@upstash/qstash"
import { waitUntil } from "@vercel/functions"
import { runCrawlPipeline } from "./crawler/pipeline"
import { crawler } from "./config"
import { debugLog } from "./log"

const qstash: Client | null = (() => {
  if (!process.env.QSTASH_TOKEN) return null
  // `baseUrl` is region-specific. The Upstash Vercel integration
  // ships a `QSTASH_URL` env var pointing at the account's home
  // region (e.g. `https://qstash-us-east-1.upstash.io`). If we
  // don't pass it, the SDK defaults to the eu-central-1 endpoint,
  // which silently returns 404 for accounts hosted elsewhere —
  // no exception, no visible error, message never lands.
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
  // Unconditional one-liner so Vercel runtime logs show which path
  // fired for every enqueue. Removable once the queue path is
  // validated end-to-end, but useful as a long-term operational
  // signal — a sudden jump in `fallback:*` events in prod means
  // QStash state has drifted.
  console.info(`[enqueueCrawl] branch=${branch} jobId=${jobId}`)

  if (qstash && workerUrl) {
    try {
      await qstash.publishJSON({
        url: workerUrl,
        body: { jobId, url },
        retries: 3,
        // Wait the full pipeline budget before declaring the delivery
        // a failure. Matches `crawler.PIPELINE_BUDGET_MS` — the
        // pipeline self-terminates at that point and writes a
        // "failed" state; QStash treats our 200 response as success
        // either way.
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
