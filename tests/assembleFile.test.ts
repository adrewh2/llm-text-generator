import { describe, test } from "node:test"
import assert from "node:assert/strict"
import { assembleFile } from "../lib/crawler/output/assemble"
import { validateLlmsTxt } from "../lib/crawler/output/validate"
import type { ScoredPage } from "../lib/crawler/types"

// End-to-end pipeline check: feed realistic inputs through assembleFile
// and confirm the rendered llms.txt passes validateLlmsTxt. Catches the
// regression class where the assembler starts emitting syntactically-
// broken output (missing H1, empty sections, malformed links) without
// anything else noticing.

function page(overrides: Partial<ScoredPage>): ScoredPage {
  return {
    url: "https://example.com/",
    title: "Example",
    headings: [],
    fetchStatus: "ok",
    descriptionProvenance: "none",
    score: 0.5,
    isOptional: false,
    ...overrides,
  }
}

describe("assembleFile → validateLlmsTxt", () => {
  test("minimal: one section with two entries, no optional — valid", () => {
    const primary: ScoredPage[] = [
      page({ url: "https://example.com/docs", title: "Docs", section: "Docs", score: 0.9 }),
      page({ url: "https://example.com/docs/api", title: "API", section: "Docs", score: 0.8 }),
    ]
    const out = assembleFile("Example", primary, [])
    const result = validateLlmsTxt(out)
    assert.equal(result.valid, true, `output failed validation:\n${out}\nerrors: ${JSON.stringify(result.errors)}`)
  })

  test("with summary + preamble — blockquote appears before first H2 and output is valid", () => {
    const primary: ScoredPage[] = [
      page({ url: "https://example.com/docs", title: "Docs", section: "Docs", score: 0.9 }),
      page({ url: "https://example.com/docs/api", title: "API", section: "Docs", score: 0.8 }),
    ]
    const out = assembleFile(
      "Example",
      primary,
      [],
      "A factual one-line summary of the site.",
      "A longer preamble paragraph that describes the site in a bit more depth.",
    )
    assert.ok(out.includes("> A factual one-line summary"), "blockquote expected")
    // Blockquote must appear before the first `## ` line.
    const lines = out.split("\n")
    const bqIdx = lines.findIndex((l) => l.startsWith("> "))
    const h2Idx = lines.findIndex((l) => l.startsWith("## "))
    assert.ok(bqIdx !== -1 && h2Idx !== -1 && bqIdx < h2Idx, "blockquote must precede first H2")
    assert.equal(validateLlmsTxt(out).valid, true)
  })

  test("with optional pages — ## Optional is rendered last and output is valid", () => {
    const primary: ScoredPage[] = [
      page({ url: "https://example.com/docs", title: "Docs", section: "Docs", score: 0.9 }),
      page({ url: "https://example.com/docs/api", title: "API", section: "Docs", score: 0.8 }),
    ]
    const optional: ScoredPage[] = [
      page({ url: "https://example.com/legal", title: "Legal", isOptional: true, score: 0.3 }),
    ]
    const out = assembleFile("Example", primary, optional)
    const h2s = out.split("\n").filter((l) => l.startsWith("## "))
    assert.equal(h2s[h2s.length - 1], "## Optional", `got: ${h2s.join(" | ")}`)
    assert.equal(validateLlmsTxt(out).valid, true)
  })

  test("URLs with parens are percent-encoded so markdown links don't terminate early", () => {
    const primary: ScoredPage[] = [
      page({ url: "https://example.com/wiki/Foo_(film)", title: "Foo (film)", section: "Articles", score: 0.9 }),
      page({ url: "https://example.com/wiki/Bar", title: "Bar", section: "Articles", score: 0.8 }),
    ]
    const out = assembleFile("Example", primary, [])
    assert.ok(out.includes("%28film%29"), `expected %28film%29 in output:\n${out}`)
    // Raw literal `(film)` must not appear inside the parenthesised link target,
    // only as part of the surrounding markdown syntax — the validator would
    // catch a broken link entry downstream.
    assert.equal(validateLlmsTxt(out).valid, true)
  })

  test("empty siteName → 'Untitled' H1", () => {
    const primary: ScoredPage[] = [
      page({ url: "https://example.com/a", title: "A", section: "Docs", score: 0.9 }),
      page({ url: "https://example.com/b", title: "B", section: "Docs", score: 0.8 }),
    ]
    const out = assembleFile("", primary, [])
    assert.ok(out.startsWith("# Untitled\n"), `got: ${out.slice(0, 30)}`)
    assert.equal(validateLlmsTxt(out).valid, true)
  })

  test("multi-line description is flattened to a single line (no mid-entry newline)", () => {
    const primary: ScoredPage[] = [
      page({
        url: "https://example.com/x",
        title: "X",
        section: "Docs",
        score: 0.9,
        description: "Line one.\nLine two.",
        descriptionProvenance: "llm",
      }),
      page({ url: "https://example.com/y", title: "Y", section: "Docs", score: 0.8 }),
    ]
    const out = assembleFile("Example", primary, [])
    assert.ok(out.includes("Line one. Line two."))
    assert.ok(!out.includes("Line one.\nLine two."))
    assert.equal(validateLlmsTxt(out).valid, true)
  })

  test("robots notice renders as a warning blockquote and doesn't break validation", () => {
    const primary: ScoredPage[] = [
      page({ url: "https://example.com/docs", title: "Docs", section: "Docs", score: 0.9 }),
      page({ url: "https://example.com/docs/api", title: "API", section: "Docs", score: 0.8 }),
    ]
    const out = assembleFile(
      "Example",
      primary,
      [],
      undefined,
      undefined,
      "This site's robots.txt disallows all crawling.",
    )
    assert.ok(out.includes("> ⚠️"), "robots notice expected as a warning blockquote")
    assert.equal(validateLlmsTxt(out).valid, true)
  })
})
