import type { ScoredPage } from "../types"
import { toLabel, urlPathSegments, urlToLabel } from "../net/urlLabel"

export function assembleFile(
  siteName: string,
  primary: ScoredPage[],
  optional: ScoredPage[],
  summary?: string,
  preamble?: string,
  robotsNotice?: string,
): string {
  const lines: string[] = []

  lines.push(`# ${siteName || "Untitled"}`, "")

  if (summary) {
    const clean = summary.replace(/\r?\n/g, " ").trim()
    if (clean) lines.push(`> ${clean}`, "")
  }

  if (preamble) {
    const clean = preamble.replace(/\r?\n/g, " ").trim()
    if (clean) lines.push(clean, "")
  }

  if (robotsNotice) {
    lines.push(`> ⚠️ ${robotsNotice}`, "")
  }

  const { sections, overflow } = groupBySection(primary)

  // Pages from single-entry sections spill into Optional
  const allOptional = [
    ...overflow,
    ...optional,
  ].sort((a, b) => b.score - a.score)

  // Resolve display labels across the whole output set. First collapse
  // titles that just repeat the site name into URL-derived labels, then
  // disambiguate any remaining title collisions by prefixing the first
  // distinguishing path segment. Result: no two entries in the output
  // share the same link text.
  const allEntries = [
    ...[...sections.values()].flat(),
    ...allOptional,
  ]
  const labels = resolveDisplayLabels(allEntries, siteName)

  for (const [section, pages] of sections) {
    lines.push(`## ${section}`, "")
    for (const page of pages) lines.push(formatEntry(page, labels.get(page.url)))
    lines.push("")
  }

  if (allOptional.length > 0) {
    lines.push("## Optional", "")
    for (const page of allOptional) lines.push(formatEntry(page, labels.get(page.url)))
    lines.push("")
  }

  return lines.join("\n").trimEnd() + "\n"
}

function formatEntry(page: ScoredPage, label?: string): string {
  const url = encodeMarkdownUrl(formatDisplayUrl(page.mdUrl || page.url))
  const title = (label ?? page.title ?? url).replace(/[\[\]]/g, "")
  if (page.description && page.descriptionProvenance !== "none") {
    const desc = page.description.replace(/\r?\n/g, " ").trim()
    return `- [${title}](${url}): ${desc}`
  }
  return `- [${title}](${url})`
}

/**
 * An unescaped `)` inside the URL terminates a markdown link early
 * (`[Foo](https://a/b(c))` parses the closing paren of `b(c)` as the
 * link end). CommonMark permits balanced parens, but renderers vary —
 * percent-encoding both parens is the portable fix.
 */
function encodeMarkdownUrl(url: string): string {
  return url.replace(/\(/g, "%28").replace(/\)/g, "%29")
}

/**
 * Trim the trailing slash from bare-origin URLs (`https://host.tld/`)
 * so the rendered markdown reads the way the site itself writes its
 * own links — `https://llmstxt.org`, not `https://llmstxt.org/`. The
 * WHATWG URL parser always emits `/` for root paths, so the stored
 * cache key keeps it (stability); the slash is stripped only at
 * render time.
 */
function formatDisplayUrl(url: string): string {
  try {
    const u = new URL(url)
    if (u.pathname === "/" && !u.search && !u.hash) {
      return `${u.protocol}//${u.host}`
    }
    return url
  } catch {
    return url
  }
}

// ─── Label resolution ────────────────────────────────────────────────────────

/**
 * Produce a per-URL display label that's distinct from every other
 * label in the output set. Two passes:
 *   1. If a page's title equals the site name (case-insensitive), swap
 *      it for a URL-derived label — otherwise hub pages like
 *      /military/, /wmd/, /intell/ all show up as "GlobalSecurity.org"
 *      in the output.
 *   2. For any titles that still collide across two or more entries,
 *      prefix the first path segment that differs between them —
 *      "/military/library/" and "/wmd/library/" both have title
 *      "Library"; they become "Military Library" and "Wmd Library".
 */
function resolveDisplayLabels(pages: ScoredPage[], siteName: string): Map<string, string> {
  const siteNorm = siteName.trim().toLowerCase()
  const labels = new Map<string, string>()

  // A page title that shows up on many pages is a site-wide tagline,
  // not a per-page title — typically an SPA that forgot to update
  // document.title on route change. Treat it the same as
  // `title === siteName`: fall back to a URL-derived label so each
  // entry is actually distinguishable. Threshold of 3 avoids
  // misfiring on real 2-page collisions that Pass 2 handles fine.
  const titleCounts = new Map<string, number>()
  for (const p of pages) {
    const t = (p.title || "").trim().toLowerCase()
    if (t) titleCounts.set(t, (titleCounts.get(t) ?? 0) + 1)
  }
  const GENERIC_TITLE_THRESHOLD = 3
  const isGenericTitle = (lower: string): boolean =>
    (titleCounts.get(lower) ?? 0) >= GENERIC_TITLE_THRESHOLD

  // Pass 1: site-name-as-title OR site-wide-repeated tagline → URL label.
  for (const p of pages) {
    const t = (p.title || "").trim()
    const tLower = t.toLowerCase()
    if (t && (tLower === siteNorm || isGenericTitle(tLower))) {
      const derived = urlToLabel(p.url)
      if (derived) labels.set(p.url, derived)
      continue
    }
    if (t) labels.set(p.url, t)
  }

  // Pass 2: disambiguate remaining collisions.
  const byLabel = new Map<string, ScoredPage[]>()
  for (const p of pages) {
    const l = labels.get(p.url)
    if (!l) continue
    const arr = byLabel.get(l) ?? []
    arr.push(p)
    byLabel.set(l, arr)
  }
  for (const [, group] of byLabel) {
    if (group.length < 2) continue
    const paths = group.map((p) => urlPathSegments(p.url))
    const maxLen = Math.max(...paths.map((p) => p.length))
    let diffIdx = -1
    for (let i = 0; i < maxLen; i++) {
      const set = new Set(paths.map((p) => p[i] ?? ""))
      if (set.size > 1) { diffIdx = i; break }
    }
    if (diffIdx === -1) continue
    group.forEach((p, i) => {
      const seg = paths[i][diffIdx]
      if (!seg) return
      const prefix = toLabel(seg)
      const original = labels.get(p.url) ?? p.title ?? p.url
      labels.set(p.url, prefix ? `${prefix} ${original}` : original)
    })
  }

  return labels
}

function groupBySection(pages: ScoredPage[]): {
  sections: Map<string, ScoredPage[]>
  overflow: ScoredPage[]
} {
  const map = new Map<string, ScoredPage[]>()
  for (const page of pages) {
    const section = page.section || "Resources"
    const existing = map.get(section)
    if (existing) existing.push(page)
    else map.set(section, [page])
  }

  // Heuristic for dissolving singleton sections:
  //   - If >= 2 sections have >= 2 pages, the LLM did a reasonable
  //     grouping job — keep the singletons as their own sections.
  //     A legitimate "Pricing" or "About" section with one page
  //     deserves its own header rather than being flattened.
  //   - If 0-1 sections have >= 2 pages, the LLM fragmented too
  //     aggressively (typical symptom: small commerce sites where
  //     every page gets a unique label). Dissolve all singletons
  //     into Optional so the file reads coherently.
  const multiPageCount = [...map.values()].filter((ps) => ps.length >= 2).length
  const shouldDissolve = multiPageCount < 2

  const overflow: ScoredPage[] = []
  const valid = new Map<string, ScoredPage[]>()
  for (const [section, ps] of map) {
    if (shouldDissolve && ps.length < 2) overflow.push(...ps)
    else valid.set(section, ps)
  }

  // Sort sections by an effective score: avg per-page score plus a
  // small structural-label boost. The LLM's per-page importance
  // signal carries the bulk of the judgment (the enrichBatch prompt
  // tells the model to score structural pages 8–10 and catalogue
  // items 4–7), but in practice the LLM bunches its scores in the
  // middle, so a catalogue section full of richly-described items
  // can edge out a structural section of terser pages on raw avg
  // alone. The structural-label boost gives universally-foundational
  // labels (About, Services, Support, Pricing, Docs, …) a thumb on
  // the scale large enough to win small avg-score gaps but small
  // enough that a genuinely-stronger catalogue section still ranks
  // above a thin structural one.
  const entries = [...valid.entries()].sort((a, b) => {
    return effectiveScore(b[0], b[1]) - effectiveScore(a[0], a[1])
  })

  return { sections: new Map(entries), overflow }
}

function effectiveScore(name: string, pages: ScoredPage[]): number {
  const avg = pages.reduce((s, p) => s + p.score, 0) / pages.length
  // (priority − 50) × 0.3: About at priority 100 → +15 boost,
  // Services at 90 → +12, Support at 60 → +3, default-50 labels →
  // 0, Blog at 40 → −3. Calibrated against per-page scores in the
  // 30–80 range so the boost matters at the edges without
  // overwhelming a genuinely-higher catalogue avg.
  return avg + (sectionPriority(name) - 50) * 0.3
}

// Structural-label priority. Limited to labels with stable cross-
// genre meaning in the llms.txt shape (About is About on every site;
// Pricing is Pricing on every site). Genre-specific labels and
// catalogue-shaped section nouns are deliberately NOT in here —
// that judgment is the LLM's via the per-page importance score. The
// table only nudges sections that the LLM grouped under a known
// structural header; sections with LLM-invented labels get the
// neutral default and sort by raw avg-score.
const SECTION_PRIORITY: Record<string, number> = {
  about: 100,
  company: 100,
  products: 90,
  services: 90,
  pricing: 85,
  plans: 85,
  docs: 80,
  documentation: 80,
  api: 78,
  reference: 75,
  guides: 70,
  tutorials: 70,
  examples: 70,
  support: 60,
  help: 60,
  faq: 60,
  resources: 50,
  blog: 40,
  news: 40,
  changelog: 40,
}

function sectionPriority(name: string): number {
  return SECTION_PRIORITY[name.toLowerCase()] ?? 50
}
