import type { ScoredPage, SiteGenre, PageType } from "./types"

const GENRE_SECTION_MAP: Record<SiteGenre, Partial<Record<PageType, string>>> = {
  developer_docs: {
    doc: "Docs", api: "API", example: "Examples", changelog: "Changelog",
    blog: "Optional", about: "Optional",
  },
  ecommerce: {
    product: "Products", pricing: "Pricing", support: "Support",
    policy: "Policies", blog: "Optional",
  },
  personal_site: {
    about: "About", project: "Projects", blog: "Writing", other: "Optional",
  },
  institutional: {
    program: "Programs", about: "About", support: "Contact & Support",
    policy: "Policies", news: "Optional",
  },
  blog_publication: {
    blog: "Articles", about: "About", support: "Resources", policy: "Optional",
  },
  generic: {},
}

export function assignSections(pages: ScoredPage[], genre: SiteGenre): ScoredPage[] {
  return pages.map((page) => {
    if (page.score < 30) return { ...page, section: undefined }

    if (page.isOptional || page.score < 50) {
      return { ...page, section: "Optional" }
    }

    const sectionMap = GENRE_SECTION_MAP[genre]
    const mapped = sectionMap[page.pageType]

    if (mapped === "Optional") {
      // Upgrade to primary section based on path
      return { ...page, section: inferSectionFromPath(page) }
    }

    return { ...page, section: mapped || inferSectionFromPath(page) }
  })
}

function inferSectionFromPath(page: ScoredPage): string {
  const path = new URL(page.url).pathname.toLowerCase()

  if (/\/docs?\//.test(path)) return "Docs"
  if (/\/api\//.test(path)) return "API"
  if (/\/guide\//.test(path)) return "Guides"
  if (/\/examples?\//.test(path)) return "Examples"
  if (/\/blog\/|\/post\/|\/article\//.test(path)) return "Blog"
  if (/\/about\//.test(path)) return "About"
  if (/\/support\/|\/help\//.test(path)) return "Support"
  if (/\/products?\//.test(path)) return "Products"

  return "Resources"
}

export function filterAndSelectPages(
  pages: ScoredPage[],
  maxOutput = 60
): { primary: ScoredPage[]; optional: ScoredPage[] } {
  // Deduplicate by URL (canonical wins)
  const seen = new Set<string>()
  const deduped = pages.filter((p) => {
    if (seen.has(p.url)) return false
    seen.add(p.url)
    return true
  })

  const primary = deduped
    .filter((p) => p.score >= 50 && p.section && p.section !== "Optional")
    .sort((a, b) => b.score - a.score)
    .slice(0, maxOutput - 10)

  const primaryUrls = new Set(primary.map((p) => p.url))

  const optional = deduped
    .filter((p) => {
      if (p.score < 30 || p.score >= 50) return false
      if (primaryUrls.has(p.url)) return false
      // Skip bare index pages if a more specific page from same path is primary
      const path = (() => { try { return new URL(p.url).pathname } catch { return "" } })()
      if (path === "/" || path === "") return false
      return true
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, 10)

  return { primary, optional }
}
