// Change detection for monitored pages.
//
// Computes a cheap "signature" over two primary change signals for a site:
//   1. Its sitemap (URL set) — the thing that actually invalidates an
//      llms.txt when pages are added or removed.
//   2. Its homepage HTML — a fallback signal for sites without a sitemap,
//      and a secondary signal for structure/copy changes the sitemap misses.
//
// The signature is a single sha256 hex string; any mismatch against the
// stored one triggers a full re-crawl. False positives (e.g. marketing
// copy tweak) cost one extra crawl — cheaper than missing a real update.
//
// Kept deliberately small so one cron invocation can check many sites:
// 2 HTTP requests per page, no Puppeteer.

import { createHash } from "crypto"
import { fetchSitemapUrls } from "./sitemap"
import { safeFetch } from "./safeFetch"
import { USER_AGENT } from "./fetchPage"
import { crawler } from "../config"

const { HOMEPAGE_FETCH_TIMEOUT_MS } = crawler

/**
 * Fetch the signature inputs and return a single hash. Returns `null`
 * when both signals fail — the caller should treat that as "can't tell,
 * skip this cycle" rather than a forced re-crawl.
 */
export async function computeSignature(pageUrl: string): Promise<string | null> {
  const base = safeBase(pageUrl)
  if (!base) return null

  const sitemapUrl = new URL("/sitemap.xml", base).toString()
  const [sitemapHash, homepageHash] = await Promise.all([
    hashSitemap(sitemapUrl, base),
    hashHomepage(base),
  ])

  if (!sitemapHash && !homepageHash) return null
  return sha256(`${sitemapHash ?? ""}|${homepageHash ?? ""}`)
}

export interface ChangeResult {
  changed: boolean
  newSignature: string | null
}

/**
 * Compare a freshly computed signature to the stored one. If signature
 * can't be computed (both fetches failed), return `changed: false` and a
 * null signature so the caller skips this cycle without churn.
 */
export async function detectChange(
  pageUrl: string,
  storedSignature: string | null,
): Promise<ChangeResult> {
  const newSignature = await computeSignature(pageUrl)
  if (newSignature === null) return { changed: false, newSignature: null }

  // First-ever check: record the signature, don't crawl.
  if (!storedSignature) return { changed: false, newSignature }

  return { changed: newSignature !== storedSignature, newSignature }
}

// ─── internals ───────────────────────────────────────────────────────────────

async function hashSitemap(sitemapUrl: string, base: string): Promise<string | null> {
  try {
    const urls = await fetchSitemapUrls(sitemapUrl, base)
    if (urls.length === 0) return null
    // Sort so insertion-order noise doesn't flip the hash.
    const sorted = [...urls].sort()
    return sha256(sorted.join("\n"))
  } catch {
    return null
  }
}

async function hashHomepage(url: string): Promise<string | null> {
  try {
    const res = await safeFetch(url, {
      signal: AbortSignal.timeout(HOMEPAGE_FETCH_TIMEOUT_MS),
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "text/html,application/xhtml+xml",
      },
    })
    if (!res.ok) return null
    const html = await res.text()
    return sha256(normalizeHtml(html))
  } catch {
    return null
  }
}

// Strip non-content noise (scripts, styles, comments) and collapse
// whitespace so dynamic build ids or minified bundles don't produce a
// new signature on every request.
function normalizeHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\s+/g, " ")
    .trim()
}

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex")
}

function safeBase(pageUrl: string): string | null {
  try {
    const u = new URL(pageUrl)
    return `${u.protocol}//${u.host}`
  } catch {
    return null
  }
}
