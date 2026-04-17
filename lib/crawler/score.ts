import type { ExtractedPage, ScoredPage, SiteGenre, PageType } from "./types"
import { classifyPage } from "./classify"
import type { EnrichmentMap } from "./llmEnrich"

export function scorePages(
  pages: ExtractedPage[],
  genre: SiteGenre,
  enrichment?: EnrichmentMap
): ScoredPage[] {
  return pages.map((page) => {
    const enriched = enrichment?.get(page.url)
    const pageType: PageType = enriched?.pageType ?? classifyPage(page.url, page.title)

    // Prefer LLM-generated description over extracted one
    const description =
      enriched?.description && enriched.description !== page.description
        ? enriched.description
        : page.description
    const descriptionProvenance =
      enriched?.description && enriched.description !== page.description
        ? enriched.descriptionProvenance
        : page.descriptionProvenance

    const enrichedPage = { ...page, description, descriptionProvenance }

    let score = 0

    // Content quality signals
    if (enrichedPage.description && enrichedPage.descriptionProvenance !== "none") score += 25
    if (enrichedPage.mdUrl) score += 20
    if (enrichedPage.descriptionProvenance === "json_ld") score += 10
    if (enrichedPage.headings.length > 0) score += 10
    if (enrichedPage.bodyExcerpt && enrichedPage.bodyExcerpt.length > 200) score += 10

    // URL quality penalties
    if (/[?&]page=\d+|\/page\/\d+/.test(page.url)) score -= 15
    if (/\/(print|export)\//.test(page.url)) score -= 20
    if (/\/(tag|category|archive|author)\//.test(page.url)) score -= 25

    // LLM importance is the primary relevance signal
    if (enriched?.importance !== undefined) {
      // Map 1–10 to a -25…+25 modifier
      score += Math.round((enriched.importance - 5.5) * 5)
    }

    const isOptional = score >= 15 && score < 50

    return { ...enrichedPage, pageType, score, isOptional, llmSection: enriched?.section }
  })
}
