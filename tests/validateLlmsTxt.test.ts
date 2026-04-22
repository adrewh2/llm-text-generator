import { describe, test } from "node:test"
import assert from "node:assert/strict"
import { validateLlmsTxt } from "../lib/crawler/output/validate"

function expectInvalid(content: string, errorSubstring: string): void {
  const result = validateLlmsTxt(content)
  assert.equal(result.valid, false, `expected invalid, got valid for:\n${content}`)
  const hit = result.errors.some((e) => e.message.includes(errorSubstring))
  assert.ok(hit, `expected an error containing "${errorSubstring}", got:\n${JSON.stringify(result.errors, null, 2)}`)
}

describe("validateLlmsTxt", () => {
  describe("happy path", () => {
    test("minimal valid file — H1 + section + one entry", () => {
      const content = [
        "# Example",
        "",
        "> A blockquote summary.",
        "",
        "## Docs",
        "",
        "- [Getting started](https://example.com/start)",
      ].join("\n")
      const result = validateLlmsTxt(content)
      assert.equal(result.valid, true, JSON.stringify(result.errors))
    })

    test("multiple sections with Optional last", () => {
      const content = [
        "# Example",
        "",
        "## Docs",
        "- [Start](https://example.com/start)",
        "",
        "## Examples",
        "- [Cookbook](https://example.com/cookbook)",
        "",
        "## Optional",
        "- [Legal](https://example.com/legal)",
      ].join("\n")
      assert.equal(validateLlmsTxt(content).valid, true)
    })
  })

  describe("H1 requirements", () => {
    test("missing H1 — invalid", () => {
      expectInvalid("## Docs\n- [x](https://x.com)", "must begin with an H1")
    })
    test("empty file — invalid", () => {
      expectInvalid("", "must begin with an H1")
    })
    test("multiple H1s — invalid", () => {
      const content = ["# A", "", "# B", "", "## Docs", "- [x](https://x.com)"].join("\n")
      expectInvalid(content, "exactly one H1")
    })
  })

  describe("heading-depth rules", () => {
    test("H3 — invalid", () => {
      const content = ["# A", "", "## Docs", "### Subsection", "- [x](https://x.com)"].join("\n")
      expectInvalid(content, "H3+ headings are not allowed")
    })
    test("H4 — invalid", () => {
      const content = ["# A", "", "#### Deep", "", "## Docs", "- [x](https://x.com)"].join("\n")
      expectInvalid(content, "H3+ headings are not allowed")
    })
  })

  describe("structural ordering", () => {
    test("blockquote after first H2 — invalid", () => {
      const content = ["# A", "", "## Docs", "- [x](https://x.com)", "", "> out of order"].join("\n")
      expectInvalid(content, "Blockquote summary must appear before the first H2")
    })
    // Preamble-heading rule is effectively shadowed by the H1-count and
    // H3+ rules in every reachable input, so there's no clean way to
    // unit-test it in isolation without contrived contradictions.
  })

  describe("## Optional rules", () => {
    test("appears twice — invalid", () => {
      const content = [
        "# A",
        "",
        "## Optional",
        "- [x](https://x.com)",
        "",
        "## Optional",
        "- [y](https://y.com)",
      ].join("\n")
      expectInvalid(content, "at most once")
    })
    test("not the last section — invalid", () => {
      const content = [
        "# A",
        "",
        "## Optional",
        "- [x](https://x.com)",
        "",
        "## Docs",
        "- [y](https://y.com)",
      ].join("\n")
      expectInvalid(content, "must be the last H2")
    })
  })

  describe("section + entry rules", () => {
    test("section with no entries — invalid", () => {
      const content = ["# A", "", "## Docs", ""].join("\n")
      expectInvalid(content, "no list entries")
    })
    test("bare bullet (not a link) — invalid", () => {
      const content = ["# A", "", "## Docs", "- plain bullet"].join("\n")
      expectInvalid(content, "link format")
    })
    test("relative URL — invalid", () => {
      const content = ["# A", "", "## Docs", "- [rel](/relative-path)"].join("\n")
      expectInvalid(content, "Invalid or relative URL")
    })
    test("ftp URL — invalid", () => {
      const content = ["# A", "", "## Docs", "- [x](ftp://example.com/)"].join("\n")
      expectInvalid(content, "Invalid or relative URL")
    })
    test("duplicate URL across sections — invalid", () => {
      const content = [
        "# A",
        "",
        "## Docs",
        "- [x](https://example.com/page)",
        "",
        "## Guides",
        "- [also x](https://example.com/page)",
      ].join("\n")
      expectInvalid(content, "Duplicate URL")
    })
  })

  describe("valid variations", () => {
    test("blockquote before H2 — valid", () => {
      const content = [
        "# A",
        "",
        "> summary line",
        "",
        "## Docs",
        "- [x](https://x.com)",
      ].join("\n")
      assert.equal(validateLlmsTxt(content).valid, true)
    })
    test("multi-line preamble paragraph before first H2 — valid", () => {
      const content = [
        "# A",
        "",
        "A paragraph describing the site across a couple lines",
        "of prose, with no headings in it.",
        "",
        "## Docs",
        "- [x](https://x.com)",
      ].join("\n")
      assert.equal(validateLlmsTxt(content).valid, true)
    })
  })
})
