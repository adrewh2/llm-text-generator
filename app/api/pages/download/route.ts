import { NextResponse } from "next/server"
import JSZip from "jszip"
import { getUserPageResults } from "@/lib/store"
import { createClient } from "@/lib/supabase/server"

export const runtime = "nodejs"

export async function GET() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return new NextResponse(null, { status: 401 })

  const pages = await getUserPageResults(user.id)
  if (pages.length === 0) {
    return NextResponse.json({ error: "No completed pages to download" }, { status: 404 })
  }

  const zip = new JSZip()
  const folder = zip.folder("llms-txt")!
  const usedNames = new Set<string>()
  for (const page of pages) {
    const filename = uniqueFilename(buildFilename(page.url), usedNames)
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

/** Turn a URL into a safe, readable filename ending in `.txt`. */
function buildFilename(url: string): string {
  try {
    const u = new URL(url)
    const host = u.hostname.replace(/^www\./, "")
    const pathSegs = u.pathname
      .split("/")
      .filter((s) => s && !/^index\.(html?|php|aspx?)$/i.test(s))
      .map((s) => s.replace(/\.[^.]+$/, ""))
    const suffix = pathSegs.length > 0 ? `_${pathSegs.join("_")}` : ""
    const raw = `${host}${suffix}`
    // Replace anything outside [A-Za-z0-9._-] with "-" and trim repeats
    const safe = raw.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/-+/g, "-")
    return `${safe}.txt`
  } catch {
    return `page-${Date.now()}.txt`
  }
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
