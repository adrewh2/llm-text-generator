import { describe, test } from "node:test"
import assert from "node:assert/strict"
import { isSpaHtml } from "../lib/crawler/discovery/spaCrawler"

describe("isSpaHtml", () => {
  describe("modern SPA shells (empty mount div, low text)", () => {
    test("React 18+ empty root div is an SPA", () => {
      const html = `<html><body><div id="root"></div></body></html>`
      assert.equal(isSpaHtml(html, ""), true)
    })
    test("Next.js __next empty div", () => {
      const html = `<html><body><div id="__next"></div></body></html>`
      assert.equal(isSpaHtml(html, ""), true)
    })
    test("Nuxt __nuxt empty div", () => {
      const html = `<html><body><div id="__nuxt"></div></body></html>`
      assert.equal(isSpaHtml(html, ""), true)
    })
    test("Svelte empty div", () => {
      const html = `<html><body><div id="svelte"></div></body></html>`
      assert.equal(isSpaHtml(html, ""), true)
    })
    test("non-empty root div (SSR'd React) is NOT an SPA", () => {
      const html = `<html><body><div id="root"><h1>Hello world</h1><p>Some content here that makes the page look SSRd</p></div></body></html>`
      const excerpt = "Hello world Some content here that makes the page look SSRd"
      assert.equal(isSpaHtml(html, excerpt), false)
    })
  })

  describe("bundled SPA shells (large HTML, low text)", () => {
    test("large inline-config payload with almost no text → SPA", () => {
      const html = `<html><head><script>${"x".repeat(6000)}</script></head><body><div></div></body></html>`
      assert.equal(isSpaHtml(html, ""), true)
    })
    test("large HTML with substantial text → not SPA", () => {
      const html = `<html>${"pad".repeat(2000)}</html>`
      const excerpt = "A".repeat(500)
      assert.equal(isSpaHtml(html, excerpt), false)
    })
  })

  describe("framework signals (only fire when text is minimal)", () => {
    test("Angular ng-app + low text → SPA", () => {
      assert.equal(isSpaHtml(`<html ng-app="x"><body></body></html>`, ""), true)
    })
    test("Angular ng-app + substantial text → NOT an SPA", () => {
      const excerpt = "A".repeat(400)
      assert.equal(isSpaHtml(`<html ng-app="x"><body></body></html>`, excerpt), false)
    })
    test("legacy React data-reactroot + low text → SPA", () => {
      assert.equal(isSpaHtml(`<div data-reactroot></div>`, ""), true)
    })
    test("unrendered template syntax {{ ... }} + low text → SPA", () => {
      assert.equal(isSpaHtml(`<div>{{ foo.bar }}</div>`, ""), true)
    })
  })

  describe("regular content pages", () => {
    test("well-rendered page with real text → not SPA", () => {
      const html = `<html><body><h1>Blog post</h1><p>${"Article text. ".repeat(30)}</p></body></html>`
      const excerpt = "Blog post " + "Article text. ".repeat(30)
      assert.equal(isSpaHtml(html, excerpt), false)
    })
    test("short HTML with some text but no SPA signals → not SPA", () => {
      const html = `<html><body><h1>Tiny</h1><p>A short page with a little text.</p></body></html>`
      const excerpt = "Tiny A short page with a little text."
      assert.equal(isSpaHtml(html, excerpt), false)
    })
  })
})
