import { NextResponse } from "next/server"
import JSZip from "jszip"
import { getUserPageResults } from "@/lib/store"
import { createClient } from "@/lib/supabase/server"
import { urlToFilename } from "@/lib/crawler/net/urlLabel"
import { api, rateLimit } from "@/lib/config"
import { consumeRateLimit } from "@/lib/upstash/rateLimit"

export const runtime = "nodejs"

const MAX_DOWNLOAD_ENTRIES = api.DOWNLOAD_MAX_ENTRIES

export async function GET() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return new NextResponse(null, { status: 401 })

  // One zip per user per 24h. Zipping + shipping up to 500 page
  // results is our most expensive authenticated read; bound it so a
  // signed-in attacker can't loop the endpoint.
  const rate = await consumeRateLimit(`zip:${user.id}`, rateLimit.AUTH_ZIP_DOWNLOAD)
  if (!rate.allowed) {
    return NextResponse.json(
      { error: "Download limit reached. Try again later.", retryAfterSec: rate.retryAfterSec },
      { status: 429, headers: { "Retry-After": String(rate.retryAfterSec) } },
    )
  }

  const pages = await getUserPageResults(user.id, { limit: MAX_DOWNLOAD_ENTRIES })
  if (pages.length === 0) {
    return NextResponse.json({ error: "No completed pages to download" }, { status: 404 })
  }

  const zip = new JSZip()
  // `folder()` can only return null when the given path conflicts with
  // an existing file — impossible on a fresh zip, but guard anyway.
  const folder = zip.folder("llms-txt")
  if (!folder) {
    return NextResponse.json({ error: "Failed to create archive folder" }, { status: 500 })
  }
  const usedNames = new Set<string>()
  for (const page of pages) {
    const filename = uniqueFilename(urlToFilename(page.url), usedNames)
    folder.file(filename, page.result)
  }

  const buf = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" })
  const today = new Date().toISOString().slice(0, 10)

  return new NextResponse(new Uint8Array(buf), {
    status: 200,
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="llms-txt-${today}.zip"`,
      "Content-Length": String(buf.byteLength),
      "Cache-Control": "no-store",
    },
  })
}

/** Suffix with `-2`, `-3`, … when the same base name repeats. */
function uniqueFilename(name: string, used: Set<string>): string {
  if (!used.has(name)) { used.add(name); return name }
  const [stem, ext] = name.endsWith(".txt") ? [name.slice(0, -4), ".txt"] : [name, ""]
  let i = 2
  while (used.has(`${stem}-${i}${ext}`)) i++
  const out = `${stem}-${i}${ext}`
  used.add(out)
  return out
}
