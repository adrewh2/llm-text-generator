import Anthropic from "@anthropic-ai/sdk"
import type { ExtractedPage, PageType, ScoredPage, SiteGenre, DescriptionProvenance } from "./types"
import { SECTION_HINTS } from "./config"
import { debugLog } from "../log"

// Pin one model across every LLM call so upgrades are a one-line swap.
const MODEL = "claude-haiku-4-5-20251001"
const BATCH_SIZE = 20

interface EnrichedData {
  pageType: PageType
  description?: string
  descriptionProvenance: DescriptionProvenance
  section?: string
  importance: number // 1–10
}

export type EnrichmentMap = Map<string, EnrichedData>

const VALID_PAGE_TYPES = new Set<PageType>([
  "doc", "api", "example", "blog", "changelog",
  "about", "product", "pricing", "support", "policy",
  "program", "news", "project", "other",
])

function getClient(): Anthropic | null {
  const apiKey = process.env.ANTHROPIC_API_KEY
  return apiKey ? new Anthropic({ apiKey }) : null
}

export async function llmEnrichPages(
  pages: ExtractedPage[],
  siteName: string,
  genre: SiteGenre,
): Promise<EnrichmentMap> {
  const client = getClient()
  if (!client) return new Map()

  const batches: ExtractedPage[][] = []
  for (let i = 0; i < pages.length; i += BATCH_SIZE) {
    batches.push(pages.slice(i, i + BATCH_SIZE))
  }

  const results: EnrichmentMap = new Map()
  await Promise.all(
    batches.map(async (batch) => {
      const batchResults = await enrichBatch(client, batch, siteName, genre)
      for (const [url, data] of batchResults) results.set(url, data)
    })
  )
  return results
}

async function enrichBatch(
  client: Anthropic,
  pages: ExtractedPage[],
  siteName: string,
  genre: SiteGenre,
): Promise<EnrichmentMap> {
  const results: EnrichmentMap = new Map()

  const pageList = pages.map((p, i) => {
    const headings = p.headings.slice(0, 4).join(" | ")
    const excerpt = p.bodyExcerpt?.slice(0, 250) || ""
    return `${i + 1}. URL: ${p.url}
   Title: ${p.title || "(none)"}
   Existing description: ${p.description || "(none)"}
   Headings: ${headings || "(none)"}
   Excerpt: ${excerpt}`
  }).join("\n\n")

  const genreLabel = genre.replace(/_/g, " ")

  const prompt = `You are preparing metadata for an llms.txt file — a machine-readable index that helps LLMs understand "${siteName}" (a ${genreLabel} site).

For each page, return a JSON object with:
- "pageType": one of: doc, api, example, blog, changelog, about, product, pricing, support, policy, program, news, project, other
- "section": a short (1–4 word) section heading that best groups this page for an LLM audience. Prefer these suggested sections when they fit naturally: ${SECTION_HINTS.join(", ")}. URL path segments are a strong signal: /docs/ or /documentation/ → "Docs", /api/ or /reference/ → "API", /examples/ or /cookbook/ → "Examples", /guides/ or /tutorials/ → "Guides", /blog/ or /posts/ → "Blog", /changelog/ or /releases/ → "Changelog", /about/ → "About", /pricing/ → "Pricing", /support/ or /help/ → "Support". Use different section names when the site's domain warrants it (e.g. a recipe site might use "Recipes" instead of "Docs"). Low-value pages (legal, generic marketing) should be "Optional".
- "importance": integer 1–10. How useful is this page for an LLM trying to understand or use this site? (10 = essential reference, 1 = nearly irrelevant boilerplate)
- "description": a clear, factual 1-sentence description (max 120 chars). If the existing description is good, return it verbatim. Write a better one if it's missing, vague, or marketing-speak.

Respond ONLY with a JSON array, one object per page, same order as input.

Pages:
${pageList}`

  try {
    const message = await client.messages.create({
      model: MODEL,
      max_tokens: 2048,
      messages: [{ role: "user", content: prompt }],
    })

    const text = message.content[0].type === "text" ? message.content[0].text : ""
    const jsonMatch = text.match(/\[[\s\S]*\]/)
    if (!jsonMatch) return results

    const parsed = JSON.parse(jsonMatch[0]) as Array<{
      pageType: string
      section: string
      importance: number
      description: string
    }>

    for (let i = 0; i < pages.length; i++) {
      const item = parsed[i]
      if (!item) continue

      const pageType = VALID_PAGE_TYPES.has(item.pageType as PageType)
        ? (item.pageType as PageType)
        : "other"

      const section = typeof item.section === "string" && item.section.trim().length > 0
        ? item.section.trim()
        : undefined

      const importance = typeof item.importance === "number"
        ? Math.max(1, Math.min(10, Math.round(item.importance)))
        : 5

      const description = typeof item.description === "string" && item.description.trim().length > 10
        ? item.description.trim()
        : undefined

      results.set(pages[i].url, {
        pageType,
        section,
        importance,
        description,
        // If the LLM wrote this, label its provenance accurately so
        // scoring weights / UI badges don't misattribute it to og:.
        descriptionProvenance: description
          ? (description !== pages[i].description ? "llm" : pages[i].descriptionProvenance)
          : "none",
      })
    }
  } catch (err) {
    // Fall back to regex classification silently in prod; surface in dev.
    debugLog("llmEnrich.enrichBatch", err)
  }

  return results
}

export async function generateSitePreamble(
  siteName: string,
  genre: SiteGenre,
  primary: ScoredPage[],
  optional: ScoredPage[],
): Promise<string | undefined> {
  const client = getClient()
  if (!client) return undefined

  const allPages = [...primary, ...optional].slice(0, 20)
  const pageLines = allPages
    .map((p) => `- ${p.title}${p.description ? `: ${p.description}` : ""}`)
    .join("\n")

  const genreLabel = genre.replace(/_/g, " ")

  const prompt = `Write a 2–3 sentence description of "${siteName}" (a ${genreLabel} site) for an LLM that has never heard of it.

Cover: what the product or service is, what it does, and who uses it. Be specific and factual. No marketing language. No headings or bullet points.

Do NOT reference the llms.txt file, do NOT say "this file covers" or "this index contains" or "this document" — write about the actual website and product only.

Context (pages on this site):
${pageLines}

Return only the description text, nothing else.`

  try {
    const message = await client.messages.create({
      model: MODEL,
      max_tokens: 256,
      messages: [{ role: "user", content: prompt }],
    })

    const text = message.content[0].type === "text" ? message.content[0].text.trim() : ""
    return text.length > 20 ? text : undefined
  } catch (err) {
    debugLog("llmEnrich.generateSitePreamble", err)
    return undefined
  }
}

/**
 * Given a list of candidate URLs, returns a filtered subset worth crawling.
 * Two responsibilities:
 *   1. Pick structural pages over individual content items (ranking).
 *   2. Collapse URLs that point to the same structural page under
 *      different query params (link dedup — e.g. locale, session, OAuth
 *      redirect targets). The deterministic tracking-param list catches
 *      common cases; the LLM handles the long tail without us hardcoding
 *      per-site param dictionaries.
 */
export async function rankCandidateUrls(
  candidates: string[],
  siteName: string,
  homepageExcerpt: string,
  maxKeep = 120,
): Promise<string[]> {
  const client = getClient()
  if (!client || candidates.length === 0) return candidates

  // Very small lists: not worth a round trip — the dedup upside is
  // negligible and ranking is moot.
  if (candidates.length <= 10) return candidates

  const numbered = candidates.map((u, i) => `${i + 1}. ${u}`).join("\n")

  const prompt = `You are selecting URLs to crawl for an llms.txt file for "${siteName}".

The goal of llms.txt is to help LLMs understand what a site offers. We want structural pages that explain the site's purpose, features, capabilities, or content — NOT individual content items.

Good to crawl: documentation, guides, API references, feature pages, about/company pages, pricing, support, examples, tutorials, changelogs.
Skip: individual videos, articles, products, user profiles, search results, login pages, or anything that's one of millions of similar items.

IMPORTANT — collapse duplicate links. If multiple URLs point to the same structural page but differ only in query parameters that don't change what the page shows (locale like hl/lang, session tokens, OAuth flow parameters like continue/followup/state/service, redirect targets, tracking params), return ONLY ONE of them. Pick the shortest / cleanest variant. Examples:
- /privacy?hl=en and /privacy?hl=en-US → same page, keep one
- Three /ServiceLogin?continue=...&followup=... with different continue URLs → all the sign-in page, keep one
- /terms?gl=US&hl=en and /terms?hl=en → same terms page, keep the shorter

Homepage context:
${homepageExcerpt.slice(0, 400)}

From the ${candidates.length} candidate URLs below, return a JSON array of up to ${maxKeep} 1-based indices for the most valuable pages to crawl, with duplicates collapsed. Prefer pages that give structural insight into the site.

URLs:
${numbered}

Respond ONLY with a JSON array of integers, e.g. [1, 3, 7, 12]`

  try {
    const message = await client.messages.create({
      model: MODEL,
      max_tokens: 512,
      messages: [{ role: "user", content: prompt }],
    })

    const text = message.content[0].type === "text" ? message.content[0].text : ""
    const match = text.match(/\[[\d,\s]+\]/)
    if (!match) return candidates.slice(0, maxKeep)

    const indices: number[] = JSON.parse(match[0])
    const kept = indices
      .filter((i) => typeof i === "number" && i >= 1 && i <= candidates.length)
      .map((i) => candidates[i - 1])

    return kept.length > 0 ? kept : candidates.slice(0, maxKeep)
  } catch (err) {
    debugLog("llmEnrich.rankCandidateUrls", err)
    return candidates.slice(0, maxKeep)
  }
}
