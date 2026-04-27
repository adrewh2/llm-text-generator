import { describe, test } from "node:test"
import assert from "node:assert"
import { heuristicRank } from "../lib/crawler/enrich/llmEnrich"

describe("heuristicRank — LLM-down fallback ranker", () => {
  test("section index outranks deep leaves under it", () => {
    const out = heuristicRank(
      [
        "https://novartis.com/about/board-directors/john-doe",
        "https://novartis.com/about/board-directors/jane-smith",
        "https://novartis.com/research",
      ],
      10,
    )
    assert.equal(out[0], "https://novartis.com/research")
  })

  test("known structural sections beat unknown deep paths", () => {
    const out = heuristicRank(
      [
        "https://novartis.com/abcdefg/some-leaf-page",
        "https://novartis.com/research/cardiovascular",
        "https://novartis.com/products/oncology",
      ],
      10,
    )
    // Both /research and /products are known structural sections at
    // depth 2 → score equally; /abcdefg/... is depth 2 unknown → loses.
    assert.ok(out.indexOf("https://novartis.com/research/cardiovascular") < out.indexOf("https://novartis.com/abcdefg/some-leaf-page"))
    assert.ok(out.indexOf("https://novartis.com/products/oncology") < out.indexOf("https://novartis.com/abcdefg/some-leaf-page"))
  })

  test("date-y segments get penalized", () => {
    const out = heuristicRank(
      [
        "https://example.com/news/2024/q3/some-press-release",
        "https://example.com/news",
      ],
      10,
    )
    assert.equal(out[0], "https://example.com/news")
  })

  test("respects maxKeep", () => {
    const urls = Array.from({ length: 20 }, (_, i) => `https://example.com/path-${i}`)
    const out = heuristicRank(urls, 5)
    assert.equal(out.length, 5)
  })

  test("stable on tied scores (preserves input order)", () => {
    const urls = [
      "https://example.com/research/topic-a",
      "https://example.com/research/topic-b",
      "https://example.com/research/topic-c",
    ]
    const out = heuristicRank(urls, 3)
    assert.deepEqual(out, urls)
  })

  test("real-world novartis-shaped sitemap promotes structural pages", () => {
    // What the deterministic fallback used to produce was board /
    // exec people-bios in sitemap order. With the heuristic, the
    // structural sections should rise to the top even when the
    // sitemap leads with leaves.
    const out = heuristicRank(
      [
        "https://novartis.com/about/board-directors/ton-buechner",
        "https://novartis.com/about/board-directors/simon-moroney",
        "https://novartis.com/about/executive-committee/karen-hale",
        "https://novartis.com/about/executive-committee/lutz-hegemann",
        "https://novartis.com/research",
        "https://novartis.com/products",
        "https://novartis.com/careers",
        "https://novartis.com/innovation",
        "https://novartis.com/patients",
      ],
      4,
    )
    // The top 4 should all be section-index pages, none should be
    // an individual person bio.
    for (const url of out) {
      assert.ok(
        !/\/(board-directors|executive-committee)\/[^/]+$/.test(url),
        `bio URL leaked into top-4: ${url}`,
      )
    }
  })
})
