import type { ScoredPage } from "./types"
import { toLabel, urlPathSegments, urlToLabel } from "./urlLabel"

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
  const url = formatDisplayUrl(page.mdUrl || page.url)
  const title = (label ?? page.title ?? url).replace(/[\[\]]/g, "")
  if (page.description && page.descriptionProvenance !== "none") {
    const desc = page.description.replace(/\r?\n/g, " ").trim()
    return `- [${title}](${url}): ${desc}`
  }
  return `- [${title}](${url})`
}

/**
 * Trim the trailing slash from bare-origin URLs (`https://host.tld/`)
 * so the rendered markdown reads the way the site itself writes its
 * own links — `https://llmstxt.org`, not `https://llmstxt.org/`. The
 * WHATWG URL parser always emits `/` for root paths, so the stored
 * cache key keeps it (stability); we strip it only at render time.
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

  // Pass 1: site-name-as-title → URL label.
  for (const p of pages) {
    const t = (p.title || "").trim()
    if (t && t.toLowerCase() === siteNorm) {
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

  // Sections with only 1 page get dissolved into Optional
  const overflow: ScoredPage[] = []
  const valid = new Map<string, ScoredPage[]>()
  for (const [section, ps] of map) {
    if (ps.length < 2) overflow.push(...ps)
    else valid.set(section, ps)
  }

  // Sort sections by average score descending
  const entries = [...valid.entries()].sort((a, b) => {
    const avgA = a[1].reduce((s, p) => s + p.score, 0) / a[1].length
    const avgB = b[1].reduce((s, p) => s + p.score, 0) / b[1].length
    return avgB - avgA
  })

  return { sections: new Map(entries), overflow }
}
