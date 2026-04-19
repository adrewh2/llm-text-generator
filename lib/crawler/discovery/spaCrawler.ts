import type { Browser, Page } from "puppeteer"
import { normalizeUrl, isSameDomain, shouldSkipUrl } from "../net/url"
import { isBlockedByChallenge } from "./fetchPage"
import { assertSafeUrl } from "../net/ssrf"

// Block media-type subresources to save bandwidth; SSRF-check every
// other request so navigation redirects and XHRs can't route the
// browser into internal IP space (page.goto follows redirects without
// re-entering the `assertSafeUrl` path that `safeFetch` uses).
function installRequestInterceptor(page: Page): void {
  page.on("request", async (req) => {
    if (["image", "font", "media"].includes(req.resourceType())) {
      req.abort().catch(() => {})
      return
    }
    try {
      await assertSafeUrl(req.url())
      req.continue().catch(() => {})
    } catch {
      req.abort().catch(() => {})
    }
  })
}

/**
 * Returns true if the HTML looks like a JS-rendered SPA shell or a
 * bot-challenge page — i.e. there's no meaningful server-rendered content.
 */
export function isSpaHtml(html: string, bodyExcerpt: string): boolean {
  const textLen = bodyExcerpt.trim().length

  // Modern SPA-shell pattern: empty mount-point div in a low-text
  // HTML. Catches Vite-built React / Vue / Svelte / Nuxt shells which
  // are often under 1 KB total — the size-based check further down
  // was written for bloated CRA / Angular builds and misses these.
  // The div must be explicitly empty (`<div id="root"></div>`) so we
  // don't false-positive on SSR'd pages that happen to use
  // `id="root"` as a wrapper around real content.
  if (
    textLen < 100 &&
    /<div\s+id=["'](?:root|app|__next|__nuxt|svelte)["'][^>]*>\s*<\/div>/i.test(html)
  ) {
    return true
  }

  // Large HTML payload but almost no extractable text → SPA shell or
  // bot challenge. This is the most reliable signal for bundlers that
  // ship a lot of inline config (CRA, legacy Angular).
  if (html.length > 5000 && textLen < 100) return true

  // Framework signals only matter if there's also minimal server-rendered text.
  // Sites with substantial text (>300 chars) are SSR even if they use Angular/React.
  if (textLen > 300) return false

  // Angular / Vue mount indicators
  if (/\bng-app\b|\bng-view\b|\bdata-ng-app\b/.test(html)) return true
  // React mount indicators — legacy hooks only. React 18+ emits a
  // bare `<div id="root">` instead of attaching `data-reactroot`, so
  // the "empty mount div" heuristic above is the one that catches
  // modern React.
  if (/\bdata-reactroot\b|\bdata-react-helmet\b/.test(html)) return true
  // Unrendered template syntax (Angular/Vue bindings still in source)
  if (/\{\{[^}]{1,60}\}\}/.test(html)) return true

  return false
}

/**
 * Manages a single Puppeteer browser for the duration of a crawl.
 * Call close() when done.
 */
export class SpaBrowser {
  private browser: Browser | null = null

  async init(): Promise<void> {
    try {
      if (process.env.VERCEL) {
        const chromium = await import("@sparticuz/chromium")
        const puppeteer = await import("puppeteer-core")
        this.browser = await puppeteer.default.launch({
          args: chromium.default.args,
          executablePath: await chromium.default.executablePath(),
          headless: true,
        })
      } else {
        const puppeteer = await import("puppeteer")
        this.browser = await puppeteer.default.launch({
          headless: true,
          args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
        })
      }
    } catch (err) {
      // Surface launch failures to the caller so the pipeline fails
      // fast with a clear, scrubbable error instead of iterating a
      // queue of URLs that all return ok:false and burning the full
      // 270 s budget on "0 successful pages".
      this.browser = null
      const message = err instanceof Error ? err.message : String(err)
      throw new Error(`browser render failed (launch): ${message}`)
    }
  }

  async fetchPage(url: string): Promise<{ html: string; ok: boolean }> {
    if (!this.browser) return { html: "", ok: false }

    // Puppeteer drives a real browser and will happily connect to
    // localhost / cloud-metadata endpoints. SSRF-check before goto.
    try {
      await assertSafeUrl(url)
    } catch {
      return { html: "", ok: false }
    }

    let page: Page | null = null
    try {
      page = await this.browser.newPage()
      await page.setUserAgent(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
      )
      await page.setRequestInterception(true)
      installRequestInterceptor(page)

      const response = await page.goto(url, { waitUntil: "load", timeout: 15000 })
      // Reject HTTP errors even when the server returns a styled HTML
      // body (Google's Error 400 page, rendered sign-in errors, etc.).
      // Without this Puppeteer happily treats the error page as content.
      if (response && !response.ok()) return { html: "", ok: false }
      await new Promise((r) => setTimeout(r, 1500))

      const html = await page.content()
      if (isBlockedByChallenge(html)) return { html: "", ok: false }
      return { html, ok: true }
    } catch {
      return { html: "", ok: false }
    } finally {
      await page?.close()
    }
  }

  async fetchPageWithLinks(url: string, baseUrl: string): Promise<{
    html: string
    ok: boolean
    links: string[]
  }> {
    if (!this.browser) return { html: "", ok: false, links: [] }

    try {
      await assertSafeUrl(url)
    } catch {
      return { html: "", ok: false, links: [] }
    }

    let page: Page | null = null
    try {
      page = await this.browser.newPage()
      await page.setUserAgent(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
      )
      await page.setRequestInterception(true)
      installRequestInterceptor(page)

      const response = await page.goto(url, { waitUntil: "load", timeout: 15000 })
      if (response && !response.ok()) return { html: "", ok: false, links: [] }
      await new Promise((r) => setTimeout(r, 1500))

      const html = await page.content()
      if (isBlockedByChallenge(html)) return { html: "", ok: false, links: [] }
      // Cap raw anchor count — a hostile or over-enthusiastic page
      // (infinite-scroll archive, 100k-anchor sitemap-as-HTML) would
      // otherwise balloon memory in the normalize loop below.
      const rawLinks: string[] = await page.evaluate(() =>
        Array.from(document.querySelectorAll("a[href]"))
          .slice(0, 2000)
          .map((el) => (el as HTMLAnchorElement).href)
          .filter((h) => h.startsWith("http"))
      )

      const seen = new Set<string>()
      const links: string[] = []
      for (const raw of rawLinks) {
        const normalized = normalizeUrl(raw, baseUrl)
        if (!normalized) continue
        if (!isSameDomain(normalized, baseUrl)) continue
        if (shouldSkipUrl(normalized)) continue
        if (!seen.has(normalized)) {
          seen.add(normalized)
          links.push(normalized)
        }
      }

      return { html, ok: true, links }
    } catch {
      return { html: "", ok: false, links: [] }
    } finally {
      await page?.close()
    }
  }

  async close(): Promise<void> {
    await this.browser?.close()
    this.browser = null
  }
}
