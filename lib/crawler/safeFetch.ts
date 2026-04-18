// SSRF-aware fetch: validates each redirect hop (plain
// `redirect: "follow"` would skip — a public URL 302-ing to
// 169.254.169.254 slips past a one-time check). Known TOCTOU gap:
// DNS can rebind between our assertSafeUrl and Node's fetch. Closing
// it requires a custom undici dispatcher; out of scope.

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
