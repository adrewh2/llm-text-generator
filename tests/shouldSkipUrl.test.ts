import { describe, test } from "node:test"
import assert from "node:assert/strict"
import { shouldSkipUrl, capByPathPrefix, dropParametricFanout } from "../lib/crawler/net/url"

describe("shouldSkipUrl — SKIPPED", () => {
  describe("file extensions (non-HTML assets)", () => {
    const urls = [
      "https://example.com/photo.jpg",
      "https://example.com/icon.svg",
      "https://example.com/doc.pdf",
      "https://example.com/archive.zip",
      "https://example.com/video.mp4",
      "https://example.com/font.woff2",
      "https://example.com/styles.css",
      "https://example.com/app.js",
    ]
    for (const url of urls) {
      test(url, () => assert.equal(shouldSkipUrl(url), true))
    }
  })

  describe("known-boilerplate paths", () => {
    const urls = [
      "https://example.com/cdn-cgi/trace",
      "https://example.com/wp-login.php",
      "https://example.com/wp-admin/",
      "https://example.com/wp-json/v2/posts",
      "https://example.com/.well-known/security.txt",
      "https://example.com/feed",
      "https://example.com/rss",
      "https://example.com/atom.xml",
    ]
    for (const url of urls) {
      test(url, () => assert.equal(shouldSkipUrl(url), true))
    }
  })

  describe("pagination", () => {
    test("/page/2 in path", () =>
      assert.equal(shouldSkipUrl("https://example.com/blog/page/2"), true))
    test("?page=2 outside /docs", () =>
      assert.equal(shouldSkipUrl("https://example.com/blog?page=2"), true))
    test("?page=2 inside /docs is NOT skipped (intentional exception)", () =>
      assert.equal(shouldSkipUrl("https://example.com/docs?page=2"), false))
  })

  describe("print variants", () => {
    test("?print", () => assert.equal(shouldSkipUrl("https://example.com/article?print=1"), true))
    test("/print/", () => assert.equal(shouldSkipUrl("https://example.com/print/article"), true))
  })

  describe("archive-style taxonomies", () => {
    for (const url of [
      "https://example.com/tag/ai",
      "https://example.com/category/news",
      "https://example.com/author/jane",
      "https://example.com/archive/2024",
    ]) {
      test(url, () => assert.equal(shouldSkipUrl(url), true))
    }
  })

  describe("content-ID query params (value length >= 6)", () => {
    test("?v=abcdef (YouTube, exactly 6 chars)", () =>
      assert.equal(shouldSkipUrl("https://youtube.com/xyz?v=abcdef"), true))
    test("?id=1234567", () =>
      assert.equal(shouldSkipUrl("https://example.com/?id=1234567"), true))
    test("?postid=abc123def", () =>
      assert.equal(shouldSkipUrl("https://example.com/?postid=abc123def"), true))
    test("?article_id=9876543", () =>
      assert.equal(shouldSkipUrl("https://example.com/?article_id=9876543"), true))
    test("short value (<6 chars) does NOT trigger skip", () =>
      assert.equal(shouldSkipUrl("https://example.com/?id=12"), false))
  })

  describe("IDs in path", () => {
    test("UUID", () =>
      assert.equal(
        shouldSkipUrl("https://example.com/posts/3f2504e0-4f89-11d3-9a0c-0305e82c3301"),
        true,
      ))
    test("long numeric path segment (6+ digits)", () =>
      assert.equal(shouldSkipUrl("https://example.com/posts/123456"), true))
    test("short numeric path segment (<6 digits) does NOT trigger", () =>
      assert.equal(shouldSkipUrl("https://example.com/posts/42"), false))
  })

  describe("user / profile paths", () => {
    for (const url of [
      "https://example.com/user/jane",
      "https://example.com/users/jane",
      "https://example.com/u/jane",
      "https://example.com/profile/jane",
      "https://example.com/profiles/jane",
      "https://example.com/member/jane",
      "https://example.com/members/jane",
    ]) {
      test(url, () => assert.equal(shouldSkipUrl(url), true))
    }
  })

  describe("fused-@ handles on social platforms", () => {
    for (const url of [
      "https://medium.com/@jane/my-article",
      "https://x.com/@elonmusk/status/123456",
      "https://mastodon.social/@foo/99999",
      "https://tiktok.com/@user/video/7000000",
      "https://threads.net/@jane/post/abc",
      "https://example.com/@jane",              // bare handle, no trailing path
    ]) {
      test(url, () => assert.equal(shouldSkipUrl(url), true))
    }
  })

  describe("short-form video / individual content paths", () => {
    for (const url of [
      "https://example.com/shorts/abc",
      "https://example.com/clip/foo",
      "https://example.com/clips/bar",
      "https://example.com/reel/baz",
      "https://example.com/reels/qux",
      "https://youtube.com/watch?x=1",
    ]) {
      test(url, () => assert.equal(shouldSkipUrl(url), true))
    }
  })

  describe("invalid URL", () => {
    test("garbage input is skipped (conservative)", () =>
      assert.equal(shouldSkipUrl("not a url"), true))
  })
})

describe("shouldSkipUrl — KEPT", () => {
  const urls = [
    "https://example.com/",
    "https://example.com/docs",
    "https://example.com/docs/api",
    "https://example.com/pricing",
    "https://example.com/about",
    "https://example.com/blog/first-post",
    "https://example.com/guide/getting-started",
  ]
  for (const url of urls) {
    test(url, () => assert.equal(shouldSkipUrl(url), false))
  }
})

describe("capByPathPrefix", () => {
  test("caps URLs per prefix bucket", () => {
    const urls = [
      "https://example.com/docs/a",
      "https://example.com/docs/b",
      "https://example.com/docs/c",
      "https://example.com/api/a",
      "https://example.com/api/b",
    ]
    // depth=1, maxPerPrefix=2 → 2 from /docs + 2 from /api
    const out = capByPathPrefix(urls, 2, 1)
    assert.equal(out.length, 4)
  })

  test("root path goes to 'root' bucket", () => {
    const urls = ["https://example.com/", "https://example.com/", "https://example.com/docs/a"]
    // root bucket caps at 1, docs bucket has 1
    const out = capByPathPrefix(urls, 1, 1)
    assert.equal(out.length, 2)
  })

  test("preserves input order for kept URLs", () => {
    const urls = [
      "https://example.com/docs/a",
      "https://example.com/api/a",
      "https://example.com/docs/b",
    ]
    const out = capByPathPrefix(urls, 10, 1)
    assert.deepEqual(out, urls)
  })

  test("depth=2 buckets by two-segment prefix", () => {
    const urls = [
      "https://example.com/docs/api/a",
      "https://example.com/docs/api/b",
      "https://example.com/docs/guides/a",
    ]
    // /docs/api bucket caps at 1; /docs/guides bucket has 1
    const out = capByPathPrefix(urls, 1, 2)
    assert.equal(out.length, 2)
  })

  test("unparseable URLs pass through (defensive)", () => {
    const out = capByPathPrefix(["not a url", "also not"], 1, 1)
    assert.equal(out.length, 2)
  })

  test("within a bucket, prefers shorter paths (section index over leaf)", () => {
    // Sitemap order puts the deep leaf first, but the cap should still
    // pick the section index — that's what tells an LLM reader what
    // the section IS.
    const urls = [
      "https://example.com/about/board-directors/john-doe",
      "https://example.com/about/board-directors/",
      "https://example.com/about/board-directors/jane-smith",
    ]
    const out = capByPathPrefix(urls, 1, 2)
    assert.deepEqual(out, ["https://example.com/about/board-directors/"])
  })

  test("depth tie-break is order-stable inside a bucket", () => {
    const urls = [
      "https://example.com/about/board-directors/john-doe",
      "https://example.com/about/board-directors/jane-smith",
      "https://example.com/about/board-directors/alice-roe",
    ]
    // All three are depth 3 — none is a shorter index — so the cap
    // should keep them in input order.
    const out = capByPathPrefix(urls, 2, 2)
    assert.deepEqual(out, [
      "https://example.com/about/board-directors/john-doe",
      "https://example.com/about/board-directors/jane-smith",
    ])
  })
})

describe("dropParametricFanout", () => {
  test("drops a prefix bucket that meets the threshold", () => {
    const fanout = Array.from({ length: 25 }, (_, i) => `https://example.com/city/slug-${i}`)
    const out = dropParametricFanout(fanout, 20)
    assert.deepEqual(out, [])
  })

  test("keeps a bucket that's just under the threshold", () => {
    const urls = Array.from({ length: 19 }, (_, i) => `https://example.com/city/slug-${i}`)
    const out = dropParametricFanout(urls, 20)
    assert.equal(out.length, 19)
  })

  test("never drops depth-1 (index) URLs even when their depth-2 children get dropped", () => {
    // The /location index lives at depth 1, the /city/* fan-out at
    // depth 2. The whole /city/* bucket gets dropped; /location
    // survives because it's in a different first-segment bucket
    // ("location" vs "city") AND because depth-1 URLs are never
    // candidates for dropping in the first place.
    const urls = [
      "https://example.com/location",
      "https://example.com/city",
      ...Array.from({ length: 30 }, (_, i) => `https://example.com/city/slug-${i}`),
    ]
    const out = dropParametricFanout(urls, 20)
    assert.deepEqual(out, [
      "https://example.com/location",
      "https://example.com/city",
    ])
  })

  test("only drops the over-threshold bucket; other prefixes are unaffected", () => {
    const urls = [
      ...Array.from({ length: 30 }, (_, i) => `https://example.com/city/slug-${i}`),
      "https://example.com/about",
      "https://example.com/about/team",
      "https://example.com/products",
      "https://example.com/pricing",
    ]
    const out = dropParametricFanout(urls, 20)
    assert.deepEqual(out, [
      "https://example.com/about",
      "https://example.com/about/team",
      "https://example.com/products",
      "https://example.com/pricing",
    ])
  })

  test("multi-bucket fan-out: each over-threshold prefix drops independently", () => {
    const urls = [
      ...Array.from({ length: 25 }, (_, i) => `https://example.com/city/c-${i}`),
      ...Array.from({ length: 25 }, (_, i) => `https://example.com/region/r-${i}`),
      "https://example.com/about",
    ]
    const out = dropParametricFanout(urls, 20)
    assert.deepEqual(out, ["https://example.com/about"])
  })

  test("preserves input order for kept URLs", () => {
    const urls = [
      "https://example.com/a",
      "https://example.com/b",
      "https://example.com/c",
    ]
    assert.deepEqual(dropParametricFanout(urls, 20), urls)
  })

  test("a deep docs/{cat}/{topic} hierarchy is NOT mistaken for fan-out", () => {
    // Only depth-2 leaves count toward the threshold. A real docs
    // site has a small number of depth-2 categories
    // (/docs/auth, /docs/api, /docs/payments) and the bulk of pages
    // lives at depth 3+ (/docs/auth/oauth, /docs/api/keys, …) — so
    // even with 60+ total /docs/* URLs, the depth-2 count stays
    // tiny and the threshold doesn't trip.
    const urls = [
      // 3 depth-2 categories
      "https://example.com/docs/auth",
      "https://example.com/docs/api",
      "https://example.com/docs/payments",
      // many depth-3+ topics under each
      ...Array.from({ length: 30 }, (_, i) => `https://example.com/docs/auth/topic-${i}`),
      ...Array.from({ length: 30 }, (_, i) => `https://example.com/docs/api/endpoint-${i}`),
    ]
    const out = dropParametricFanout(urls, 20)
    // Depth-2 count for "docs" is 3 (auth, api, payments) — below
    // the threshold of 20, so nothing gets dropped.
    assert.equal(out.length, urls.length)
  })

  test("when depth-2 count trips the threshold, deeper descendants under the same prefix are dropped too", () => {
    // /city/{slug} × 25 trips the threshold. /city/{slug}/{detail}
    // is the deeper layer of the same fan-out tree and should also
    // be dropped — those are even more granular templated pages.
    const urls = [
      ...Array.from({ length: 25 }, (_, i) => `https://example.com/city/slug-${i}`),
      "https://example.com/city/slug-0/details",
      "https://example.com/city/slug-0/info",
      "https://example.com/about",
    ]
    const out = dropParametricFanout(urls, 20)
    assert.deepEqual(out, ["https://example.com/about"])
  })
})
