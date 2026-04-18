// QStash worker — runs a crawl job pushed from `enqueueCrawl`.
//
// Every invocation is a signed POST from QStash; the
// `verifySignatureAppRouter` wrapper rejects anything that isn't.
// Unlike `POST /api/p`, this route runs the pipeline synchronously
// (no `waitUntil`) so QStash's retry-on-failure semantics actually
// buy us mid-pipeline durability — if the Fluid Compute instance
// dies, we return non-2xx and QStash redelivers.

import { NextResponse } from "next/server"
import { verifySignatureAppRouter } from "@upstash/qstash/nextjs"
import { runCrawlPipeline } from "@/lib/crawler/pipeline"
import { debugLog } from "@/lib/log"

export const runtime = "nodejs"
export const maxDuration = 300

interface CrawlMessage {
  jobId?: string
  url?: string
}

async function handler(req: Request): Promise<Response> {
  let body: CrawlMessage
  try {
    body = (await req.json()) as CrawlMessage
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 })
  }

  const { jobId, url } = body
  if (!jobId || !url) {
    return NextResponse.json({ error: "Missing jobId or url" }, { status: 400 })
  }

  try {
    await runCrawlPipeline(jobId, url)
  } catch (err) {
    // `runCrawlPipeline` writes its own `failed` states for expected
    // errors; anything reaching here is unexpected. Return 500 so
    // QStash retries — the retry is harmless given the pipeline sets
    // job status to "crawling" on entry and overwrites on completion.
    debugLog("worker.crawl", err)
    return NextResponse.json({ error: "Pipeline threw" }, { status: 500 })
  }

  return NextResponse.json({ ok: true })
}

export const POST = verifySignatureAppRouter(handler)
