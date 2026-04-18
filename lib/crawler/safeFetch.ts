// Fetch wrapper that:
//   1. Pre-validates the URL via the SSRF guard before every hop.
//   2. Follows redirects manually so each hop's destination is
//      re-validated. Plain `redirect: "follow"` skips this — an
//      attacker-controlled public URL that 302s to 169.254.169.254
//      would slip past our initial check otherwise.
//
// There is a residual TOCTOU gap: between our DNS lookup in
// `assertSafeUrl` and Node's own lookup inside `fetch`, the answer
// could change (DNS rebinding). Closing this requires a custom
// `undici` dispatcher that pins the resolved IP — out of scope here.
// See README "Known limitations" for the trade-off.

import { assertSafeUrl } from "./ssrf"
import { crawler } from "../config"

const { MAX_REDIRECTS } = crawler

export async function safeFetch(
  url: string,
  init?: Omit<RequestInit, "redirect">,
): Promise<Response> {
  let currentUrl = url
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await assertSafeUrl(currentUrl)
    const res = await fetch(currentUrl, { ...init, redirect: "manual" })
    if (res.status < 300 || res.status >= 400) return res

    const location = res.headers.get("location")
    if (!location) return res

    let nextUrl: string
    try {
      nextUrl = new URL(location, currentUrl).toString()
    } catch {
      return res // malformed Location — treat as final response
    }
    if (nextUrl === currentUrl) return res // trivial redirect loop
    currentUrl = nextUrl
  }
  throw new Error(`Too many redirects (>${MAX_REDIRECTS}): ${url}`)
}
