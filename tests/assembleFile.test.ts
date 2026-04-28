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

  test("a structural-labelled section beats a slightly-higher-scored catalogue section", () => {
    // Real-world failure mode: the LLM bunched its importance scores
    // in the middle, so a section full of richly-described catalogue
    // items edges past a structural section of terser pages on raw
    // avg-score alone. The structural-label boost (+12 for Services
    // at priority 90) gives Services enough lift to win the small
    // gap that the LLM's importance signal didn't open up.
    const primary: ScoredPage[] = [
      page({ url: "https://example.com/cat/a", title: "CA", section: "Catalogue", score: 60 }),
      page({ url: "https://example.com/cat/b", title: "CB", section: "Catalogue", score: 60 }),
      page({ url: "https://example.com/svc/a", title: "SA", section: "Services", score: 55 }),
      page({ url: "https://example.com/svc/b", title: "SB", section: "Services", score: 55 }),
    ]
    const out = assembleFile("Example", primary, [])
    const h2s = out.split("\n").filter((l) => l.startsWith("## "))
    // Services boost: 55 + (90-50)*0.3 = 67. Catalogue: 60 + 0 = 60.
    assert.deepEqual(h2s, ["## Services", "## Catalogue"], `unexpected order: ${h2s.join(" | ")}`)
  })

  test("a sufficiently-higher catalogue avg-score still beats the structural-label boost", () => {
    // The boost is a thumb on the scale, not a thumb on the table.
    // When the catalogue's avg-score is far enough above the
    // structural section, it still wins — the boost only flips
    // small gaps.
    const primary: ScoredPage[] = [
      page({ url: "https://example.com/cat/a", title: "CA", section: "Catalogue", score: 80 }),
      page({ url: "https://example.com/cat/b", title: "CB", section: "Catalogue", score: 80 }),
      page({ url: "https://example.com/about", title: "About", section: "About", score: 40 }),
      page({ url: "https://example.com/team", title: "Team", section: "About", score: 40 }),
    ]
    const out = assembleFile("Example", primary, [])
    const h2s = out.split("\n").filter((l) => l.startsWith("## "))
    // About boost: 40 + (100-50)*0.3 = 55. Catalogue: 80. 25-point
    // gap is well beyond what the boost can flip.
    assert.deepEqual(h2s, ["## Catalogue", "## About"], `unexpected order: ${h2s.join(" | ")}`)
  })

  test("on tied avg-score, the structural-label boost picks the winner", () => {
    const primary: ScoredPage[] = [
      page({ url: "https://example.com/x/a", title: "XA", section: "Discoveries", score: 50 }),
      page({ url: "https://example.com/x/b", title: "XB", section: "Discoveries", score: 50 }),
      page({ url: "https://example.com/about", title: "About", section: "About", score: 50 }),
      page({ url: "https://example.com/team", title: "Team", section: "About", score: 50 }),
    ]
    const out = assembleFile("Example", primary, [])
    const h2s = out.split("\n").filter((l) => l.startsWith("## "))
    assert.deepEqual(h2s, ["## About", "## Discoveries"], `unexpected order: ${h2s.join(" | ")}`)
  })

  test("explicit sectionOrder (from LLM final review) overrides the avg-score sort", () => {
    // Without an explicit order, Catalogue would beat About on raw
    // avg-score even with the structural-priority boost (avg 80 + 0
    // = 80 vs avg 40 + 15 = 55). When the LLM final-review pass
    // returns ["About", "Catalogue"], the assembler honors it.
    const primary: ScoredPage[] = [
      page({ url: "https://example.com/cat/a", title: "CA", section: "Catalogue", score: 80 }),
      page({ url: "https://example.com/cat/b", title: "CB", section: "Catalogue", score: 80 }),
      page({ url: "https://example.com/about", title: "About", section: "About", score: 40 }),
      page({ url: "https://example.com/team", title: "Team", section: "About", score: 40 }),
    ]
    const out = assembleFile(
      "Example", primary, [], undefined, undefined, undefined,
      ["About", "Catalogue"],
    )
    const h2s = out.split("\n").filter((l) => l.startsWith("## "))
    assert.deepEqual(h2s, ["## About", "## Catalogue"], `unexpected order: ${h2s.join(" | ")}`)
  })

  test("explicit sectionOrder is a partial spec — unlisted sections appended in score order", () => {
    // LLM only listed About; Pricing and Catalogue should follow,
    // ordered against each other by their effective scores.
    const primary: ScoredPage[] = [
      page({ url: "https://example.com/cat/a", title: "CA", section: "Catalogue", score: 80 }),
      page({ url: "https://example.com/cat/b", title: "CB", section: "Catalogue", score: 80 }),
      page({ url: "https://example.com/about", title: "About", section: "About", score: 40 }),
      page({ url: "https://example.com/team", title: "Team", section: "About", score: 40 }),
      page({ url: "https://example.com/pricing", title: "P1", section: "Pricing", score: 50 }),
      page({ url: "https://example.com/plans", title: "P2", section: "Pricing", score: 50 }),
    ]
    const out = assembleFile(
      "Example", primary, [], undefined, undefined, undefined,
      ["About"],
    )
    const h2s = out.split("\n").filter((l) => l.startsWith("## "))
    // About first (explicit). Then by effective score: Catalogue
    // (80 + 0 = 80) beats Pricing (50 + (85-50)*0.3 = 60.5).
    assert.deepEqual(h2s, ["## About", "## Catalogue", "## Pricing"], `unexpected order: ${h2s.join(" | ")}`)
  })

  test("explicit sectionOrder ignores names that aren't real sections (defensive)", () => {
    // The LLM might hallucinate a section name that doesn't exist
    // in the Primary list. Such names are silently dropped.
    const primary: ScoredPage[] = [
      page({ url: "https://example.com/about", title: "About", section: "About", score: 40 }),
      page({ url: "https://example.com/team", title: "Team", section: "About", score: 40 }),
    ]
    const out = assembleFile(
      "Example", primary, [], undefined, undefined, undefined,
      ["MadeUp", "About", "AlsoFake"],
    )
    const h2s = out.split("\n").filter((l) => l.startsWith("## "))
    assert.deepEqual(h2s, ["## About"])
  })

  test("when the page title equals the site name, falls back to the H1 heading instead of the run-together URL slug", () => {
    // Real-world case: a /getstarted page whose <title> is just
    // "Quip" (the site name) and whose H1 is "Get Started". The
    // run-together slug "getstarted" → "Getstarted" via toLabel,
    // but the H1 carries the human spacing.
    const primary: ScoredPage[] = [
      page({
        url: "https://example.com/getstarted",
        title: "Example",
        section: "Resources",
        score: 50,
        headings: ["Get Started", "Sub heading"],
      }),
      page({
        url: "https://example.com/about",
        title: "About",
        section: "About",
        score: 50,
      }),
    ]
    const out = assembleFile("Example", primary, [])
    assert.ok(out.includes("[Get Started]"), `expected '[Get Started]' label, got:\n${out}`)
    assert.ok(!out.includes("[Getstarted]"), `unexpected run-together label in:\n${out}`)
  })

  test("explicit labelOverrides (from LLM final-review) win over title/heading/URL fallback", () => {
    // Even if the deterministic resolver had picked "Getstarted"
    // from the URL slug, the LLM-final-review override "Get Started"
    // takes precedence.
    const primary: ScoredPage[] = [
      page({
        url: "https://example.com/getstarted",
        title: "Example",
        section: "Resources",
        score: 50,
        headings: [],
      }),
      page({
        url: "https://example.com/about",
        title: "About",
        section: "About",
        score: 50,
      }),
    ]
    const overrides = new Map([["https://example.com/getstarted", "Get Started"]])
    const out = assembleFile(
      "Example", primary, [],
      undefined, undefined, undefined, undefined,
      overrides,
    )
    assert.ok(out.includes("[Get Started]"), `expected '[Get Started]' override:\n${out}`)
  })

  test("heading fallback skips SPA chrome / privacy headings", () => {
    // A /privacy page whose <title> matches the site name and whose
    // first heading is "Cookie Preference Center" (common consent-
    // banner artifact). The chrome-skip list filters it; the URL
    // fallback "Privacy" wins.
    const primary: ScoredPage[] = [
      page({
        url: "https://example.com/privacy",
        title: "Example",
        section: "Resources",
        score: 50,
        headings: ["Cookie Preference Center", "Privacy Policy"],
      }),
      page({
        url: "https://example.com/about",
        title: "About",
        section: "About",
        score: 50,
      }),
    ]
    const out = assembleFile("Example", primary, [])
    // The second heading "Privacy Policy" passes the chrome filter
    // and wins. The point of the test: chrome ("Cookie Preference
    // Center") is NOT picked.
    assert.ok(!out.includes("Cookie Preference Center"), `chrome heading leaked into label:\n${out}`)
  })

  test("primary entry tagged section 'Optional' funnels into the real Optional section, NOT a duplicate header", () => {
    // Repro: LLM final-review's `moves` field demoted an entry by
    // setting section: "Optional"; the page stayed in the primary
    // array, and groupBySection happily created an "Optional" bucket
    // alongside the genuine ## Optional that assembleFile renders
    // separately, producing two ## Optional headers. The fix funnels
    // any primary page tagged "Optional" (case-insensitive) into the
    // overflow that joins the real Optional section.
    const primary: ScoredPage[] = [
      page({ url: "https://example.com/docs", title: "Docs", section: "Docs", score: 80 }),
      page({ url: "https://example.com/api", title: "API", section: "Docs", score: 80 }),
      // Entry the LLM demoted post-assembly via moves
      page({ url: "https://example.com/brand", title: "Brand", section: "Optional", score: 60 }),
    ]
    const optional: ScoredPage[] = [
      page({ url: "https://example.com/privacy", title: "Privacy", section: "Optional", score: 30 }),
    ]
    const out = assembleFile("Example", primary, optional)
    const optionalHeaderCount = (out.match(/^## Optional$/gm) ?? []).length
    assert.equal(optionalHeaderCount, 1, `expected exactly one '## Optional' header, got ${optionalHeaderCount}:\n${out}`)
    // Both the demoted Brand entry and the genuine Privacy entry should
    // sit under the single Optional section.
    const optSection = out.split("## Optional")[1] ?? ""
    assert.ok(optSection.includes("Brand"), `Brand entry should be under Optional:\n${out}`)
    assert.ok(optSection.includes("Privacy"), `Privacy entry should be under Optional:\n${out}`)
    // Spec compliance: only one Optional section.
    const v = validateLlmsTxt(out)
    assert.equal(v.valid, true, `validation failed:\n${out}\nerrors: ${JSON.stringify(v.errors)}`)
  })

  test("case-insensitive: section 'optional' / 'OPTIONAL' funnel into real Optional too", () => {
    const primary: ScoredPage[] = [
      page({ url: "https://example.com/docs", title: "Docs", section: "Docs", score: 80 }),
      page({ url: "https://example.com/api", title: "API", section: "Docs", score: 80 }),
      page({ url: "https://example.com/lower", title: "Lower", section: "optional", score: 60 }),
      page({ url: "https://example.com/upper", title: "Upper", section: "OPTIONAL", score: 60 }),
    ]
    const out = assembleFile("Example", primary, [])
    const optionalHeaderCount = (out.match(/^## Optional$/gm) ?? []).length
    assert.equal(optionalHeaderCount, 1, `expected exactly one '## Optional' header:\n${out}`)
    assert.ok(out.includes("Lower") && out.includes("Upper"), `both demoted entries should appear:\n${out}`)
  })

  test("catalogue-shaped section labels are NOT hardcoded — two unknown labels tie at the neutral default", () => {
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
