import type { ExtractedPage, ScoredPage, SiteGenre, PageType } from "./types"
import { classifyPage } from "./classify"

const GENRE_MODIFIERS: Record<SiteGenre, Partial<Record<PageType, number>>> = {
  developer_docs: { doc: 20, api: 20, example: 20, blog: -15, about: -25 },
  ecommerce: { product: 25, pricing: 25, support: 15, policy: 15, changelog: -20 },
  personal_site: { about: 20, project: 20, blog: 20, other: 10 },
  institutional: { program: 20, about: 20, support: 15, policy: 15, changelog: -15 },
  blog_publication: { blog: 20, about: 10, support: 10, policy: -10 },
  generic: {},
}

export function scorePages(pages: ExtractedPage[], genre: SiteGenre): ScoredPage[] {
  return pages.map((page) => {
    const pageType = classifyPage(page.url, page.title)
    let score = 0

    if (page.description && page.descriptionProvenance !== "none") score += 25
    if (page.mdUrl) score += 20
    if (page.descriptionProvenance === "json_ld") score += 15
    if (page.headings.length > 0) score += 10
    if (page.bodyExcerpt && page.bodyExcerpt.length > 200) score += 10

    // Penalties
    if (/[?&]page=\d+|\/page\/\d+/.test(page.url)) score -= 15
    if (/\/(print|export)\//.test(page.url)) score -= 20
    if (/\/(tag|category|archive|author)\//.test(page.url)) score -= 25

    // Genre modifier
    score += GENRE_MODIFIERS[genre]?.[pageType] ?? 0

    const isOptional = score >= 30 && score < 50

    return { ...page, pageType, score, isOptional }
  })
}
