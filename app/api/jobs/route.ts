import { NextRequest, NextResponse } from "next/server"
import { randomUUID } from "crypto"
import { createJob } from "@/lib/store"
import { runCrawlPipeline } from "@/lib/crawler/pipeline"
import { isValidHttpUrl } from "@/lib/crawler/url"
import { waitUntil } from "@vercel/functions"

export const runtime = "nodejs"
export const maxDuration = 300

export async function POST(req: NextRequest) {
  let body: { url?: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }

  const { url } = body

  if (!url || typeof url !== "string") {
    return NextResponse.json({ error: "url is required" }, { status: 400 })
  }

  if (!isValidHttpUrl(url.trim())) {
    return NextResponse.json({ error: "Invalid URL — must be http:// or https://" }, { status: 400 })
  }

  const id = randomUUID()
  await createJob(id, url.trim())

  // Keep the function alive after response is sent so the pipeline completes
  waitUntil(runCrawlPipeline(id, url.trim()))

  return NextResponse.json({ job_id: id }, { status: 201 })
}
