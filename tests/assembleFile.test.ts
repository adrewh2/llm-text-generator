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

  test("structural sections sort above catalogue when LLM importance grades structural pages higher", () => {
    // LLM-up path: enrichBatch tells the model structural pages
    // score 8–10 and catalogue entries score 4–7. After that
    // weighting flows through scorePages, structural pages have
    // higher final scores and their sections sort to the top via
    // the avg-score sort — no hardcoded section name needed.
    const primary: ScoredPage[] = [
      // Catalogue entries: full-content base (description + headings + body ≈ +45)
      // + LLM importance 5 → ~ -3 modifier → final ≈ 42 each.
      page({ url: "https://example.com/listings/a", title: "Listing A", section: "Catalogue", score: 42 }),
      page({ url: "https://example.com/listings/b", title: "Listing B", section: "Catalogue", score: 42 }),
      // About pages: weaker base (terse content) + LLM importance 9
      // → +18 modifier → final ≈ 53 each, even though the page
      // body itself is shorter than the catalogue items.
      page({ url: "https://example.com/about", title: "About", section: "About", score: 53 }),
      page({ url: "https://example.com/team", title: "Team", section: "About", score: 53 }),
    ]
    const out = assembleFile("Example", primary, [])
    const h2s = out.split("\n").filter((l) => l.startsWith("## "))
    assert.deepEqual(h2s, ["## About", "## Catalogue"], `unexpected section order: ${h2s.join(" | ")}`)
  })

  test("section priority is only a tiebreaker — higher avg-score wins regardless of label", () => {
    // Even though Catalogue isn't on the SECTION_PRIORITY list and
    // About is at 100, when Catalogue's avg-score is genuinely higher
    // it should still win. The judgment lives in the score; priority
    // only tiebreaks ties.
    const primary: ScoredPage[] = [
      page({ url: "https://example.com/listings/a", title: "Listing A", section: "Catalogue", score: 80 }),
      page({ url: "https://example.com/listings/b", title: "Listing B", section: "Catalogue", score: 80 }),
      page({ url: "https://example.com/about", title: "About", section: "About", score: 40 }),
      page({ url: "https://example.com/team", title: "Team", section: "About", score: 40 }),
    ]
    const out = assembleFile("Example", primary, [])
    const h2s = out.split("\n").filter((l) => l.startsWith("## "))
    assert.deepEqual(h2s, ["## Catalogue", "## About"], `unexpected section order: ${h2s.join(" | ")}`)
  })

  test("on tied avg-score, structural priority breaks the tie", () => {
    // Two sections with identical per-page scores — without the
    // priority tiebreaker the order would be Map-insertion / hash
    // order and unstable across runs. SECTION_PRIORITY pins About
    // above an unknown label.
    const primary: ScoredPage[] = [
      page({ url: "https://example.com/x/a", title: "XA", section: "Discoveries", score: 50 }),
      page({ url: "https://example.com/x/b", title: "XB", section: "Discoveries", score: 50 }),
      page({ url: "https://example.com/about", title: "About", section: "About", score: 50 }),
      page({ url: "https://example.com/team", title: "Team", section: "About", score: 50 }),
    ]
    const out = assembleFile("Example", primary, [])
    const h2s = out.split("\n").filter((l) => l.startsWith("## "))
    assert.deepEqual(h2s, ["## About", "## Discoveries"], `unexpected section order: ${h2s.join(" | ")}`)
  })

  test("catalogue noun labels are NOT hardcoded — Listings ties against an unknown label by score alone", () => {
    // SECTION_PRIORITY only carries labels with stable cross-genre
    // meaning in the llms.txt shape — it doesn't hardcode catalogue-
    // shaped section nouns. The structural-vs-catalogue judgment is
    // the LLM's via the per-page importance score. So two unknown
    // section labels with identical avg-scores both get the neutral
    // priority default and tie cleanly, instead of one being
    // arbitrarily penalized for matching a hardcoded list.
    const primary: ScoredPage[] = [
      page({ url: "https://example.com/list/a", title: "LA", section: "Listings", score: 60 }),
      page({ url: "https://example.com/list/b", title: "LB", section: "Listings", score: 60 }),
      page({ url: "https://example.com/disc/a", title: "DA", section: "Discoveries", score: 60 }),
      page({ url: "https://example.com/disc/b", title: "DB", section: "Discoveries", score: 60 }),
    ]
    const out = assembleFile("Example", primary, [])
    const h2s = out.split("\n").filter((l) => l.startsWith("## "))
    // Both at neutral priority (50), tied avg-score → stable on
    // insertion order; the assertion is "neither got a hardcoded
    // catalogue penalty," not a specific order.
    assert.equal(h2s.length, 2)
    assert.ok(h2s.includes("## Listings"))
    assert.ok(h2s.includes("## Discoveries"))
  })
})
