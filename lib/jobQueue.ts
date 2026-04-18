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
  try {
    return new Client({ token: process.env.QSTASH_TOKEN })
  } catch (err) {
    debugLog("jobQueue.clientInit", err)
    return null
  }
})()

/**
 * Resolve the URL QStash should POST back to. Explicit
 * `QSTASH_WORKER_URL` wins; otherwise derive from Vercel's
 * deployment URL. `VERCEL_URL` is set by Vercel on every deployment
 * (Production + Preview) and never includes a scheme, so we prefix
 * `https://`. Returns `null` outside Vercel with no explicit
 * override — callers will fall back to the in-process path.
 */
function resolveWorkerUrl(): string | null {
  if (process.env.QSTASH_WORKER_URL) return process.env.QSTASH_WORKER_URL
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}/api/worker/crawl`
  return null
}

export async function enqueueCrawl(jobId: string, url: string): Promise<void> {
  const workerUrl = resolveWorkerUrl()
  if (qstash && workerUrl) {
    try {
      await qstash.publishJSON({
        url: workerUrl,
        body: { jobId, url },
        retries: 3,
        // Wait the full pipeline budget + a bit of slack before
        // declaring the delivery a failure. Matches
        // `crawler.PIPELINE_BUDGET_MS` — the pipeline self-terminates
        // at that point and writes a "failed" state; QStash treats
        // our 200 response as success either way.
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
