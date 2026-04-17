import type { Browser, Page } from "puppeteer"
import { normalizeUrl, isSameDomain, shouldSkipUrl } from "./url"

/**
 * Returns true if the HTML looks like a JS-rendered SPA shell or a
 * bot-challenge page — i.e. there's no meaningful server-rendered content.
 */
export function isSpaHtml(html: string, bodyExcerpt: string): boolean {
  // Angular / Vue mount indicators
  if (/\bng-app\b|\bng-view\b|\bdata-ng-app\b/.test(html)) return true
  // React mount indicators
  if (/\bdata-reactroot\b|\bdata-react-helmet\b/.test(html)) return true
  // Unrendered template syntax (Angular/Vue bindings still in source)
  if (/\{\{[^}]{1,60}\}\}/.test(html)) return true
  // Large HTML payload but almost no extractable text → SPA shell or bot challenge
  if (html.length > 5000 && bodyExcerpt.trim().length < 100) return true
  return false
}

/**
 * Manages a single Puppeteer browser for the duration of a crawl.
 * Call close() when done.
 */
export class SpaBrowser {
  private browser: Browser | null = null

  async init(): Promise<void> {
    const puppeteer = await import("puppeteer")
    this.browser = await puppeteer.default.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
    })
  }

  async fetchPage(url: string): Promise<{ html: string; ok: boolean }> {
    if (!this.browser) return { html: "", ok: false }

    let page: Page | null = null
    try {
      page = await this.browser.newPage()
      await page.setUserAgent(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
      )
      await page.setRequestInterception(true)
      page.on("request", (req) => {
        if (["image", "font", "media"].includes(req.resourceType())) {
          req.abort()
        } else {
          req.continue()
        }
      })

      await page.goto(url, { waitUntil: "networkidle2", timeout: 20000 })
      await new Promise((r) => setTimeout(r, 800))

      const html = await page.content()
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

    let page: Page | null = null
    try {
      page = await this.browser.newPage()
      await page.setUserAgent(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
      )
      await page.setRequestInterception(true)
      page.on("request", (req) => {
        if (["image", "font", "media"].includes(req.resourceType())) {
          req.abort()
        } else {
          req.continue()
        }
      })

      await page.goto(url, { waitUntil: "networkidle2", timeout: 20000 })
      await new Promise((r) => setTimeout(r, 800))

      const html = await page.content()
      const rawLinks: string[] = await page.evaluate(() =>
        Array.from(document.querySelectorAll("a[href]"))
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
