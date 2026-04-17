export async function probeMarkdown(url: string): Promise<string | null> {
  const candidates = getMdCandidates(url)

  for (const mdUrl of candidates) {
    try {
      const res = await fetch(mdUrl, {
        method: "HEAD",
        signal: AbortSignal.timeout(2000),
        headers: { "User-Agent": "LlmsTxtGenerator/1.0" },
      })

      if (!res.ok) continue

      const ct = res.headers.get("content-type") || ""
      if (ct.includes("text/markdown") || ct.includes("text/x-markdown")) {
        return mdUrl
      }

      // For text/plain, do a lightweight GET to verify markdown content
      if (ct.includes("text/plain")) {
        const ismd = await verifyMarkdownContent(mdUrl)
        if (ismd) return mdUrl
      }
    } catch {
      continue
    }
  }

  return null
}

function getMdCandidates(url: string): string[] {
  try {
    const u = new URL(url)
    const path = u.pathname
    const candidates: string[] = []

    if (path.endsWith("/") || path === "") {
      const base = new URL(url)
      base.pathname = (path.endsWith("/") ? path : path + "/") + "index.html.md"
      candidates.push(base.toString())
    } else {
      const withMd = new URL(url)
      withMd.hash = ""
      withMd.search = ""
      withMd.pathname = path + ".md"
      candidates.push(withMd.toString())
    }

    return candidates
  } catch {
    return []
  }
}

async function verifyMarkdownContent(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(2000),
      headers: {
        "User-Agent": "LlmsTxtGenerator/1.0",
        Range: "bytes=0-4095",
      },
    })
    if (!res.ok) return false
    const text = await res.text()
    return /^#{1,6} /m.test(text) || /\[.+\]\(.+\)/.test(text)
  } catch {
    return false
  }
}
