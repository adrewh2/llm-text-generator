import type { ExtractedPage, ScoredPage, SiteGenre } from "../types"
import { isOffPrimaryLanguage } from "../net/language"
import type { EnrichmentMap } from "./llmEnrich"

export function scorePages(
  pages: ExtractedPage[],
  genre: SiteGenre,
  primaryLang: string,
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

    // Off-primary-language penalty — preference, not a filter.
    // Enough to push a localized duplicate below its primary-language
    // twin (which usually clears the 50-point primary/optional
    // threshold). On apple.com the primary is en, so /ar/iphone sinks
    // beneath /iphone; on nikkei.com the primary is ja, so /en/ pages
    // are the ones that get penalized.
    if (isOffPrimaryLanguage(page.url, page.lang, primaryLang)) {
      score -= 20
    }

    // LLM importance is the primary relevance signal.
    // Map 1–10 to an integer modifier in [-23, +23] via (x − 5.5) × 5.
    if (enriched?.importance !== undefined) {
      score += Math.round((enriched.importance - 5.5) * 5)
    }

    const isOptional = score >= 15 && score < PRIMARY_SCORE_THRESHOLD

    return { ...enrichedPage, score, isOptional, llmSection: enriched?.section }
  })
}

/**
 * Pages with `score >= PRIMARY_SCORE_THRESHOLD` land in primary
 * (under their LLM-assigned section heading); anything in
 * `[INCLUDE_SCORE_THRESHOLD, PRIMARY_SCORE_THRESHOLD)` lands in
 * Optional; below that gets dropped.
 *
 * 40 is deliberate: base quality signals cap at ~45 for a typical
 * subpage (description + headings + long excerpt + no mdUrl +
 * no json_ld), so a threshold of 50 demanded either LLM importance
 * ≥ 7 or the mdUrl bonus (+20). On a normal corporate site that
 * left most real sub-pages stuck at 48 → Optional even when the
 * LLM had clearly classified them as Products / Support / etc.
 */
export const PRIMARY_SCORE_THRESHOLD = 40
export const INCLUDE_SCORE_THRESHOLD = 15
