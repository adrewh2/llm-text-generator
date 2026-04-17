import type { ScoredPage, SiteGenre } from "./types"

function normalizeForComparison(url: string): string {
  try {
    const u = new URL(url)
    return `${u.hostname}${u.pathname.replace(/\/$/, "")}`
  } catch {
    return url
  }
}

export function assignSections(pages: ScoredPage[], _genre: SiteGenre): ScoredPage[] {
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
  // Deduplicate by URL, and exclude the root/homepage
  const seen = new Set<string>()
  const deduped = pages.filter((p) => {
    if (seen.has(p.url)) return false
    seen.add(p.url)
    if (baseUrl && normalizeForComparison(p.url) === normalizeForComparison(baseUrl)) return false
    const path = (() => { try { return new URL(p.url).pathname } catch { return "" } })()
    if (path === "/" || path === "") return false
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
      const path = (() => { try { return new URL(p.url).pathname } catch { return "" } })()
      if (path === "/" || path === "") return false
      return true
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, 10)

  return { primary, optional }
}
