import { normalizeUrl, isSameDomain, shouldSkipUrl } from "./url"

/**
 * Returns true if the HTML looks like a JS-rendered SPA shell —
 * i.e. there's no meaningful server-rendered content or links.
 */
export function isSpaHtml(html: string, bodyExcerpt: string): boolean {
  // Angular / Vue / React mount indicators
  if (/\bng-app\b|\bng-view\b|\bdata-ng-app\b/.test(html)) return true
  if (/\bdata-reactroot\b|\bdata-react-helmet\b/.test(html)) return true

  // Template syntax still in the HTML (unrendered Angular/Vue bindings)
  if (/\{\{[^}]{1,60}\}\}/.test(html)) return true

  // Almost no extractable text despite a non-trivial HTML payload
  const htmlLen = html.length
  const textLen = bodyExcerpt.trim().length
  if (htmlLen > 5000 && textLen < 100) return true

  return false
}

/**
 * Uses a headless Puppeteer browser to render a page and return
 * the rendered HTML plus all same-domain links found on the page.
 * Only call this when isSpaHtml() returns true.
 */
export async function extractLinksFromRenderedPage(
  url: string,
  baseUrl: string,
): Promise<{ html: string; links: string[] }> {
  // Dynamic import so Puppeteer is only loaded when needed
  const puppeteer = await import("puppeteer")
  const browser = await puppeteer.default.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
  })

  try {
    const page = await browser.newPage()
    await page.setUserAgent(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    )

    // Block images, fonts, and media to speed up rendering
    await page.setRequestInterception(true)
    page.on("request", (req) => {
      const type = req.resourceType()
      if (["image", "font", "media", "stylesheet"].includes(type)) {
        req.abort()
      } else {
        req.continue()
      }
    })

    await page.goto(url, { waitUntil: "networkidle2", timeout: 20000 })

    // Wait a bit for any lazy-rendered navigation to appear
    await new Promise((r) => setTimeout(r, 1000))

    const html = await page.content()

    const links = await page.evaluate((base) => {
      return Array.from(document.querySelectorAll("a[href]"))
        .map((el) => (el as HTMLAnchorElement).href)
        .filter((h) => h.startsWith("http"))
    }, baseUrl)

    const seen = new Set<string>()
    const filtered: string[] = []
    for (const raw of links) {
      const normalized = normalizeUrl(raw, baseUrl)
      if (!normalized) continue
      if (!isSameDomain(normalized, baseUrl)) continue
      if (shouldSkipUrl(normalized)) continue
      if (!seen.has(normalized)) {
        seen.add(normalized)
        filtered.push(normalized)
      }
    }

    return { html, links: filtered }
  } finally {
    await browser.close()
  }
}
