import type { ScoredPage } from "../types"

function normalizeForComparison(url: string): string {
  try {
    const u = new URL(url)
    // Treat "/", "/index.html", "/index.php", "/index.aspx" etc. as the
    // same canonical path — otherwise a page whose sitemap-declared URL
    // ends in /index.html escapes the homepage filter and the dedup
    // pass, ending up as a redundant entry in the output.
    const path = u.pathname
      .replace(/\/index\.(html?|php|aspx?)$/i, "/")
      .replace(/\/$/, "")
    return `${u.hostname}${path}`
  } catch {
    return url
  }
}

export function assignSections(pages: ScoredPage[]): ScoredPage[] {
  return pages.map((page) => {
    if (page.score < 15) return { ...page, section: undefined }

    if (page.isOptional || page.score < 50) {
      return { ...page, section: "Optional" }
    }

    // LLM-suggested section is the primary signal
    if (page.llmSection && page.llmSection !== "Optional") {
      return { ...page, section: page.llmSection }
    }

    // Fallback: infer from URL structure
    return { ...page, section: inferSectionFromPath(page) }
  })
}

function inferSectionFromPath(page: ScoredPage): string {
  try {
    const path = new URL(page.url).pathname.toLowerCase()
    if (/\/docs?\//.test(path)) return "Docs"
    if (/\/api\//.test(path)) return "API"
    if (/\/guide\//.test(path)) return "Guides"
    if (/\/examples?\//.test(path)) return "Examples"
    if (/\/blog\/|\/post\/|\/article\//.test(path)) return "Blog"
    if (/\/about\//.test(path)) return "About"
    if (/\/support\/|\/help\//.test(path)) return "Support"
    if (/\/products?\//.test(path)) return "Products"
  } catch {}
  return "Resources"
}

export function filterAndSelectPages(
  pages: ScoredPage[],
  baseUrl?: string,
  maxOutput = 60
): { primary: ScoredPage[]; optional: ScoredPage[] } {
  const baseHostname = baseUrl
    ? (() => { try { return new URL(baseUrl).hostname } catch { return null } })()
    : null

  // Drop same-domain root-path URLs — if we crawled "/" on the site
  // we started from, it's the current `llms.txt`'s home and is
  // already represented by the H1. Scoped to the base hostname so
  // external references like llmstxt.org/ survive this filter.
  const isOwnHomepage = (url: string): boolean => {
    try {
      const u = new URL(url)
      if (u.hostname !== baseHostname) return false
      return u.pathname === "/" || u.pathname === ""
    } catch { return false }
  }

  // Deduplicate by hostname+path (not exact URL) so same-page query
  // variants the normalizer didn't strip still collapse. Sort by score
  // descending first so the highest-scored version wins the slot.
  const seen = new Set<string>()
  const deduped = [...pages]
    .sort((a, b) => b.score - a.score)
    .filter((p) => {
      const key = normalizeForComparison(p.url)
      if (seen.has(key)) return false
      seen.add(key)
      if (baseUrl && key === normalizeForComparison(baseUrl)) return false
      if (isOwnHomepage(p.url)) return false
      return true
    })

  const primary = deduped
    .filter((p) => p.score >= 50 && p.section && p.section !== "Optional")
    .sort((a, b) => b.score - a.score)
    .slice(0, maxOutput - 10)

  const primaryUrls = new Set(primary.map((p) => p.url))

  const optional = deduped
    .filter((p) => {
      if (p.score < 15 || p.score >= 50) return false
      if (primaryUrls.has(p.url)) return false
      return true
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, 10)

  // Single-page-site fallback. The homepage is normally excluded as
  // redundant with the H1, but on sites where it's the *only*
  // crawlable content (Vite/SvelteKit/React SPA one-pagers, simple
  // tools, dashboards — jamlunch.com was the motivating case) that
  // leaves the output empty and the pipeline fails the job. Rescue
  // the homepage here so we still produce a valid (if minimal)
  // llms.txt: `# <SiteName>` + `## Optional` with the single
  // homepage link. Sections aren't required by the spec, but we
  // place it under Optional so the tiering stays meaningful.
  if (primary.length === 0 && optional.length === 0) {
    const rescueHomepage = pages
      .filter((p) => isOwnHomepage(p.url) && p.score >= 15)
      .sort((a, b) => b.score - a.score)[0]
    if (rescueHomepage) {
      optional.push(rescueHomepage)
    }
  }

  return { primary, optional }
}
