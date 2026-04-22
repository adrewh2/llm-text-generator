import { describe, test } from "node:test"
import assert from "node:assert/strict"
import { urlToFilename, urlPathSegments, urlToLabel, toLabel } from "../lib/crawler/net/urlLabel"

describe("urlToFilename", () => {
  test("simple URL — hostname.txt", () =>
    assert.equal(urlToFilename("https://example.com/"), "example.com.txt"))

  test("strips www.", () =>
    assert.equal(urlToFilename("https://www.example.com/"), "example.com.txt"))

  test("path segments joined with underscore", () =>
    assert.equal(urlToFilename("https://example.com/docs/api"), "example.com_docs_api.txt"))

  test("strips /index.html", () =>
    assert.equal(urlToFilename("https://example.com/docs/index.html"), "example.com_docs.txt"))

  test("strips file extension from final segment", () =>
    assert.equal(urlToFilename("https://example.com/page.html"), "example.com_page.txt"))

  test("sanitizes unusual chars", () => {
    const result = urlToFilename("https://example.com/path with spaces")
    // Spaces → '-'; the literal space chars must not remain.
    assert.ok(!result.includes(" "))
    assert.ok(result.endsWith(".txt"))
  })

  test("falls back to page-<ts>.txt on invalid URL", () => {
    const result = urlToFilename("not a url")
    assert.match(result, /^page-\d+\.txt$/)
  })

  test("output is always filesystem-safe ([A-Za-z0-9._-]+.txt)", () => {
    const result = urlToFilename("https://example.com/a/b/c")
    assert.match(result, /^[A-Za-z0-9._-]+\.txt$/)
  })

  test("collapses runs of dashes from sanitized chars", () => {
    const result = urlToFilename("https://example.com/a//b")
    // Double slash becomes empty path segment, filtered out.
    assert.equal(result, "example.com_a_b.txt")
  })
})

describe("urlPathSegments", () => {
  test("splits path and drops blanks + /index.html", () =>
    assert.deepEqual(urlPathSegments("https://example.com/docs/api/index.html"), ["docs", "api"]))
  test("root path → empty", () =>
    assert.deepEqual(urlPathSegments("https://example.com/"), []))
  test("trailing slash → last segment preserved", () =>
    assert.deepEqual(urlPathSegments("https://example.com/docs/"), ["docs"]))
  test("invalid URL → empty", () =>
    assert.deepEqual(urlPathSegments("not a url"), []))
})

describe("urlToLabel", () => {
  test("deepest segment, title-cased", () =>
    assert.equal(urlToLabel("https://example.com/docs/getting-started"), "Getting Started"))
  test("strips file extension before labelling", () =>
    assert.equal(urlToLabel("https://example.com/api.html"), "Api"))
  test("root → empty string", () =>
    assert.equal(urlToLabel("https://example.com/"), ""))
})

describe("toLabel", () => {
  test("kebab-case → Title Case", () =>
    assert.equal(toLabel("getting-started"), "Getting Started"))
  test("snake_case → Title Case", () =>
    assert.equal(toLabel("user_profile"), "User Profile"))
  test("mixed separators collapse to single spaces", () =>
    assert.equal(toLabel("foo__bar--baz"), "Foo Bar Baz"))
})
