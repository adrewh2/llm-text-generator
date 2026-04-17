const MAX_SIZE = 5 * 1024 * 1024

export interface FetchResult {
  ok: boolean
  status?: number
  html?: string
  error?: string
}

export async function fetchPage(url: string): Promise<FetchResult> {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(15000),
      headers: {
        "User-Agent": "LlmsTxtGenerator/1.0 (+https://llmstxtgenerator.com/about/crawler)",
        Accept: "text/html,application/xhtml+xml",
        "Accept-Language": "en-US,en;q=0.9",
      },
      redirect: "follow",
    })

    const contentType = res.headers.get("content-type") || ""
    if (!contentType.includes("text/html") && !contentType.includes("application/xhtml")) {
      return { ok: false, status: res.status, error: "Not HTML" }
    }

    const contentLength = res.headers.get("content-length")
    if (contentLength && parseInt(contentLength) > MAX_SIZE) {
      return { ok: false, error: "Response too large" }
    }

    const buffer = await res.arrayBuffer()
    if (buffer.byteLength > MAX_SIZE) {
      return { ok: false, error: "Response too large" }
    }

    const html = new TextDecoder().decode(buffer)
    return { ok: true, status: res.status, html }
  } catch (e: unknown) {
    const err = e as Error
    if (err?.name === "AbortError" || err?.name === "TimeoutError") {
      return { ok: false, error: "Timeout" }
    }
    return { ok: false, error: err?.message || "Fetch error" }
  }
}
