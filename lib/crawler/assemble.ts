import type { ScoredPage } from "./types"

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

  for (const [section, pages] of sections) {
    lines.push(`## ${section}`, "")
    for (const page of pages) lines.push(formatEntry(page))
    lines.push("")
  }

  if (allOptional.length > 0) {
    lines.push("## Optional", "")
    for (const page of allOptional) lines.push(formatEntry(page))
    lines.push("")
  }

  return lines.join("\n").trimEnd() + "\n"
}

function formatEntry(page: ScoredPage): string {
  const url = page.mdUrl || page.url
  const title = (page.title || url).replace(/[\[\]]/g, "")
  if (page.description && page.descriptionProvenance !== "none") {
    const desc = page.description.replace(/\r?\n/g, " ").trim()
    return `- [${title}](${url}): ${desc}`
  }
  return `- [${title}](${url})`
}

function groupBySection(pages: ScoredPage[]): {
  sections: Map<string, ScoredPage[]>
  overflow: ScoredPage[]
} {
  const map = new Map<string, ScoredPage[]>()
  for (const page of pages) {
    const section = page.section || "Resources"
    if (!map.has(section)) map.set(section, [])
    map.get(section)!.push(page)
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
