// Pure string helpers for deriving / cleaning a site's display name.
// No cheerio or other server-only deps — used by the deterministic
// fallback in extract.ts and as a safety net on the LLM's output in
// llmEnrich.ts.

/**
 * Clean up a raw site-name candidate (from og:site_name, <title>,
 * <h1>, JSON-LD, etc.) into something that looks like a brand.
 *
 * Site names should be short — 1 to 4 words, like "Stripe" or "Uber
 * Eats". If we got back a full page title, a marketing tagline, or a
 * cheerio .text() concatenation that mashed SVG icon labels into a
 * heading, we collapse whitespace, strip common suffixes, and take
 * only the first segment before a separator (|, ·, •, —, –).
 *
 * Returns `null` when the input can't be coerced into something
 * brand-shaped — callers should fall back to `siteNameFromHostname`.
 */
export function cleanSiteName(raw: string | null | undefined): string | null {
  if (!raw) return null

  // Collapse whitespace. Cheerio's .text() concatenates adjacent text
  // nodes from nested markup — that's how we end up with strings like
  // "OnlineArrow launchThree lines" on sites that wrap SVG icons
  // inside <h1> or <title>. A single pass here tidies the most
  // obvious junk before pattern matching.
  let name = raw.replace(/\s+/g, " ").trim()
  if (!name) return null

  // Strip common marketing suffixes:
  //   "Stripe | Financial Infrastructure"  → "Stripe"
  //   "Quick start - Next.js"              → "Quick start"
  //   "Acme - Home"                        → "Acme"
  name = name
    .replace(/\s+[|·•—–]\s+[^|·•—–]{1,60}$/, "")
    .replace(/\s+-\s+\w[^-]{0,40}$/, "")
    .replace(/\s*(Home|Homepage|Welcome|Official Site|Official Website)\s*$/i, "")
    .trim()

  // If still long, or still contains a separator, take the first
  // segment. Real brand names don't contain |, ·, •, —, or –, so the
  // presence of one is a strong signal that we're looking at a
  // "Brand | Tagline | More" compound.
  if (name.length > 40 || /[|·•—–]/.test(name)) {
    const first = name.split(/\s*[|·•—–]\s*/)[0]?.trim()
    if (first && first.length >= 2 && first.length <= 60) name = first
  }

  // Hard cap — anything still > 60 chars isn't a brand name.
  if (!name || name.length < 2 || name.length > 60) return null

  return name
}

/**
 * Derive a reasonable display name from a hostname when no better
 * candidate is available. "www.example-shop.com" → "Example Shop".
 */
export function siteNameFromHostname(hostname: string): string {
  return hostname
    .replace(/^www\./, "")
    .split(".")[0]
    .replace(/-/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase())
}

