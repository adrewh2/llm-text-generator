import { describe, test } from "node:test"
import assert from "node:assert/strict"
import { normalizeUrl, altWwwForm, isSameDomain, isValidHttpUrl } from "../lib/crawler/net/url"

describe("normalizeUrl", () => {
  describe("scheme", () => {
    test("http accepted", () =>
      assert.equal(normalizeUrl("http://example.com/"), "http://example.com/"))
    test("https accepted", () =>
      assert.equal(normalizeUrl("https://example.com/"), "https://example.com/"))
    test("ftp rejected", () =>
      assert.equal(normalizeUrl("ftp://example.com/"), null))
    test("javascript: rejected", () =>
      assert.equal(normalizeUrl("javascript:alert(1)"), null))
    test("garbage input returns null", () =>
      assert.equal(normalizeUrl("not a url"), null))
  })

  describe("credential stripping (security)", () => {
    test("userinfo stripped — protects credentials", () =>
      assert.equal(
        normalizeUrl("https://alice:sekret@example.com/docs"),
        "https://example.com/docs",
      ))
    test("username-only stripped", () =>
      assert.equal(
        normalizeUrl("https://alice@example.com/"),
        "https://example.com/",
      ))
  })

  describe("fragment + case normalisation", () => {
    test("hash stripped", () =>
      assert.equal(
        normalizeUrl("https://example.com/docs#section"),
        "https://example.com/docs",
      ))
    test("hostname lowercased", () =>
      assert.equal(
        normalizeUrl("https://Example.COM/docs"),
        "https://example.com/docs",
      ))
  })

  describe("trailing slash on non-root paths", () => {
    test("trailing slash on /docs stripped", () =>
      assert.equal(
        normalizeUrl("https://example.com/docs/"),
        "https://example.com/docs",
      ))
    test("root / preserved", () =>
      assert.equal(
        normalizeUrl("https://example.com/"),
        "https://example.com/",
      ))
    test("nested trailing slash stripped", () =>
      assert.equal(
        normalizeUrl("https://example.com/a/b/"),
        "https://example.com/a/b",
      ))
  })

  describe("tracking-param stripping", () => {
    test("utm_* stripped", () => {
      const got = normalizeUrl("https://example.com/docs?utm_source=x&utm_campaign=y&utm_content=z")
      assert.equal(got, "https://example.com/docs")
    })
    test("gclid / fbclid stripped", () => {
      assert.equal(
        normalizeUrl("https://example.com/?gclid=abc&fbclid=def"),
        "https://example.com/",
      )
    })
    test("locale params stripped (hl, gl, lang)", () => {
      assert.equal(
        normalizeUrl("https://example.com/privacy?hl=en&gl=us&lang=en-US"),
        "https://example.com/privacy",
      )
    })
    test("OAuth redirect params stripped (continue, next, state)", () => {
      assert.equal(
        normalizeUrl("https://example.com/?continue=/dashboard&state=xyz&next=/x"),
        "https://example.com/",
      )
    })
    test("Google session tokens stripped (dsh, osid, ifkv)", () => {
      assert.equal(
        normalizeUrl("https://example.com/?dsh=1&osid=2&ifkv=3"),
        "https://example.com/",
      )
    })
    test("legitimate search params preserved", () => {
      assert.equal(
        normalizeUrl("https://example.com/search?q=foo&page=2"),
        "https://example.com/search?q=foo&page=2",
      )
    })
    test("tracking mixed with legitimate params — only tracking stripped", () => {
      assert.equal(
        normalizeUrl("https://example.com/search?q=foo&utm_source=tw&ref=abc"),
        "https://example.com/search?q=foo",
      )
    })
  })

  describe("base param", () => {
    test("resolves relative URLs against a base", () =>
      assert.equal(
        normalizeUrl("/docs", "https://example.com/"),
        "https://example.com/docs",
      ))
    test("absolute URL ignores base", () =>
      assert.equal(
        normalizeUrl("https://other.com/x", "https://example.com/"),
        "https://other.com/x",
      ))
  })
})

describe("altWwwForm", () => {
  test("adds www. to a bare domain", () =>
    assert.equal(altWwwForm("https://example.com/"), "https://www.example.com/"))
  test("strips www. when already present", () =>
    assert.equal(altWwwForm("https://www.example.com/"), "https://example.com/"))
  test("preserves path + query", () =>
    assert.equal(altWwwForm("https://example.com/docs?x=1"), "https://www.example.com/docs?x=1"))
})

describe("isSameDomain", () => {
  test("identical hosts match", () =>
    assert.equal(isSameDomain("https://example.com/a", "https://example.com/"), true))
  test("www vs non-www match (treated as same)", () =>
    assert.equal(isSameDomain("https://www.example.com/a", "https://example.com/"), true))
  test("case-insensitive", () =>
    assert.equal(isSameDomain("https://Example.COM/a", "https://example.com/"), true))
  test("different hosts don't match", () =>
    assert.equal(isSameDomain("https://other.com/", "https://example.com/"), false))
  test("subdomain doesn't match parent", () =>
    assert.equal(isSameDomain("https://docs.example.com/", "https://example.com/"), false))
  test("invalid input → false", () =>
    assert.equal(isSameDomain("not a url", "https://example.com/"), false))
})

describe("isValidHttpUrl", () => {
  test("http", () => assert.equal(isValidHttpUrl("http://example.com/"), true))
  test("https", () => assert.equal(isValidHttpUrl("https://example.com/"), true))
  test("ftp rejected", () => assert.equal(isValidHttpUrl("ftp://example.com/"), false))
  test("file rejected", () => assert.equal(isValidHttpUrl("file:///tmp/x"), false))
  test("bare string rejected", () => assert.equal(isValidHttpUrl("example.com"), false))
})
