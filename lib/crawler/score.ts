import type { ExtractedPage, ScoredPage, SiteGenre } from "./types"
import type { EnrichmentMap } from "./llmEnrich"

export function scorePages(
  pages: ExtractedPage[],
  genre: SiteGenre,
  enrichment?: EnrichmentMap
): ScoredPage[] {
  return pages.map((page) => {
    const enriched = enrichment?.get(page.url)

    // Prefer LLM-generated description over extracted one
    const llmDescription =
      enriched?.description && enriched.description !== page.description
        ? enriched
        : null
    const description = llmDescription?.description ?? page.description
    const descriptionProvenance =
      llmDescription?.descriptionProvenance ?? page.descriptionProvenance

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

    // LLM importance is the primary relevance signal.
    // Map 1–10 to an integer modifier in [-23, +23] via (x − 5.5) × 5.
    if (enriched?.importance !== undefined) {
      score += Math.round((enriched.importance - 5.5) * 5)
    }

    const isOptional = score >= 15 && score < 50

    return { ...enrichedPage, score, isOptional, llmSection: enriched?.section }
  })
}
