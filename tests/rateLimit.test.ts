import { describe, test } from "node:test"
import assert from "node:assert/strict"
import { clientIp, isAllowedOrigin } from "../lib/upstash/rateLimit"

function req(headers: Record<string, string>, host = "llmstxt.sh") {
  const h = new Headers()
  for (const [k, v] of Object.entries(headers)) h.set(k, v)
  return { headers: h, nextUrl: { host } }
}

describe("isAllowedOrigin (CSRF defense)", () => {
  test("no Origin header — allowed (curl / server-to-server)", () =>
    assert.equal(isAllowedOrigin(req({})), true))

  test("matching Origin host — allowed", () =>
    assert.equal(isAllowedOrigin(req({ origin: "https://llmstxt.sh" })), true))

  test("different Origin host — rejected", () =>
    assert.equal(isAllowedOrigin(req({ origin: "https://evil.com" })), false))

  test("scheme differs, host matches — still allowed (host-only check)", () =>
    assert.equal(isAllowedOrigin(req({ origin: "http://llmstxt.sh" })), true))

  test("invalid Origin URL — rejected (conservative)", () =>
    assert.equal(isAllowedOrigin(req({ origin: "not a url" })), false))

  test("Origin with path — still matches on host", () =>
    assert.equal(isAllowedOrigin(req({ origin: "https://llmstxt.sh/some/path" })), true))

  test("subdomain mismatch — rejected (exact host match required)", () =>
    assert.equal(isAllowedOrigin(req({ origin: "https://docs.llmstxt.sh" })), false))

  test("empty Origin header — treated as allowed (same as absent)", () =>
    // req.headers.get("origin") returns null when unset, empty string when set to "".
    // `if (!origin) return true` catches both.
    assert.equal(isAllowedOrigin(req({ origin: "" })), true))
})

describe("clientIp (spoof-resistant IP extraction)", () => {
  const only = (headers: Record<string, string>) => ({ headers: new Headers(headers) })

  test("prefers x-vercel-forwarded-for over x-forwarded-for (tamper-resistant)", () =>
    assert.equal(
      clientIp(only({ "x-vercel-forwarded-for": "1.2.3.4", "x-forwarded-for": "9.9.9.9" })),
      "1.2.3.4",
    ))

  test("x-vercel-forwarded-for multi-entry — first wins", () =>
    assert.equal(clientIp(only({ "x-vercel-forwarded-for": "1.2.3.4, 5.6.7.8" })), "1.2.3.4"))

  test("falls back to x-forwarded-for when vercel header absent", () =>
    assert.equal(clientIp(only({ "x-forwarded-for": "1.2.3.4, 5.6.7.8" })), "1.2.3.4"))

  test("falls back to x-real-ip when both forwarded-for headers absent", () =>
    assert.equal(clientIp(only({ "x-real-ip": "1.2.3.4" })), "1.2.3.4"))

  test("no headers — returns 'unknown'", () =>
    assert.equal(clientIp(only({})), "unknown"))

  test("trims whitespace in x-forwarded-for", () =>
    assert.equal(clientIp(only({ "x-forwarded-for": "  1.2.3.4  ,  5.6.7.8" })), "1.2.3.4"))

  test("empty x-vercel-forwarded-for falls through to x-forwarded-for (no false anchor)", () =>
    assert.equal(
      clientIp(only({ "x-vercel-forwarded-for": "", "x-forwarded-for": "1.2.3.4" })),
      "1.2.3.4",
    ))
})
