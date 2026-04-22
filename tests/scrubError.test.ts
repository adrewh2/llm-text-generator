import { describe, test } from "node:test"
import assert from "node:assert/strict"
import { scrubError } from "../app/api/p/[id]/scrubError"

describe("scrubError", () => {
  describe("SSRF / forbidden-IP messages collapse to a generic string", () => {
    test("Unsafe URL prefix", () =>
      assert.equal(
        scrubError("Unsafe URL (forbidden IP range (127.0.0.1)): http://127.0.0.1/"),
        "This URL can't be crawled.",
      ))
    test("case-insensitive match (internal error lowercased before checks)", () =>
      assert.equal(
        scrubError("UNSAFE URL (forbidden IP range): http://10.0.0.1/"),
        "This URL can't be crawled.",
      ))
    test("forbidden IP anywhere in the message", () =>
      assert.equal(
        scrubError("Redirect landed on forbidden ip 169.254.169.254"),
        "This URL can't be crawled.",
      ))
  })

  describe("bot / site-block messages", () => {
    test("http 403", () =>
      assert.equal(scrubError("http 403: forbidden"), "This site blocked our crawler."))
    test("bot challenge", () =>
      assert.equal(scrubError("bot challenge detected"), "This site blocked our crawler."))
  })

  describe("other HTTP errors fall through to the generic http branch", () => {
    test("http 500", () =>
      assert.equal(scrubError("http 500: internal server error"), "The site returned an error."))
    test("http 502", () =>
      assert.equal(scrubError("http 502: bad gateway"), "The site returned an error."))
  })

  describe("network / timeout / DNS", () => {
    test("timeout", () =>
      assert.equal(scrubError("network timeout after 30s"), "The site took too long to respond."))
    test("timed out", () =>
      assert.equal(scrubError("Request timed out"), "The site took too long to respond."))
    test("dns lookup failed", () =>
      assert.equal(scrubError("DNS lookup failed: ENOTFOUND"), "Couldn't resolve that domain."))
  })

  describe("pipeline-internal failures", () => {
    test("browser render failed", () =>
      assert.equal(scrubError("browser render failed (launch): chromium exited"), "We couldn't render this site."))
    test("exceeded time budget", () =>
      assert.equal(scrubError("Exceeded time budget"), "Crawl took longer than our budget allows."))
  })

  describe("fallback for anything unrecognised", () => {
    test("empty string", () =>
      assert.equal(scrubError(""), "Couldn't generate a result for this site."))
    test("arbitrary message", () =>
      assert.equal(scrubError("NullPointerException at foo.bar"), "Couldn't generate a result for this site."))
    test("never leaks the raw internal message", () => {
      const raw = "database password=hunter2 leaked in error"
      assert.notEqual(scrubError(raw), raw)
    })
  })
})
