import { describe, test } from "node:test"
import assert from "node:assert/strict"
import { isAllowed, hasFullDisallow } from "../lib/crawler/discovery/robots"

describe("isAllowed", () => {
  test("empty disallow list — everything allowed", () => {
    assert.equal(isAllowed("https://example.com/any/path", []), true)
  })

  test("path not matching any rule — allowed", () => {
    assert.equal(isAllowed("https://example.com/docs", ["/admin"]), true)
  })

  test("path matching a prefix rule — disallowed", () => {
    assert.equal(isAllowed("https://example.com/admin/users", ["/admin"]), false)
  })

  test("exact path match — disallowed", () => {
    assert.equal(isAllowed("https://example.com/private", ["/private"]), false)
  })

  test("root disallow (/) blocks everything", () => {
    assert.equal(isAllowed("https://example.com/", ["/"]), false)
    assert.equal(isAllowed("https://example.com/docs/api", ["/"]), false)
  })

  test("multiple rules, any match disqualifies", () => {
    assert.equal(isAllowed("https://example.com/admin/x", ["/private", "/admin", "/tmp"]), false)
    assert.equal(isAllowed("https://example.com/public/x", ["/private", "/admin", "/tmp"]), true)
  })

  test("empty rule ('') in list is ignored (doesn't match everything)", () => {
    assert.equal(isAllowed("https://example.com/docs", ["", "/admin"]), true)
  })

  test("invalid URL — conservative: treat as not allowed", () => {
    assert.equal(isAllowed("not a url", ["/admin"]), false)
  })

  test("prefix-matching is literal, not case-insensitive", () => {
    // robots.txt is case-sensitive per spec
    assert.equal(isAllowed("https://example.com/Admin", ["/admin"]), true)
    assert.equal(isAllowed("https://example.com/admin", ["/admin"]), false)
  })
})

describe("hasFullDisallow", () => {
  test("['/'] → true", () => assert.equal(hasFullDisallow(["/"]), true))
  test("['/admin', '/'] → true", () => assert.equal(hasFullDisallow(["/admin", "/"]), true))
  test("[] → false", () => assert.equal(hasFullDisallow([]), false))
  test("['/admin'] → false (specific path, not blanket)", () =>
    assert.equal(hasFullDisallow(["/admin"]), false))
  test("['/*'] → false (wildcard, not the literal '/' rule)", () =>
    assert.equal(hasFullDisallow(["/*"]), false))
})
