import type { ScoredPage } from "./types"

const SECTION_ORDER = [
  "Docs", "API", "Examples", "Guides", "Getting Started",
  "Products", "Pricing", "Support", "About",
  "Articles", "Writing", "Projects", "Programs",
  "Policies", "Resources", "Blog", "Changelog",
  "Contact & Support",
]

export function assembleFile(
  siteName: string,
  primary: ScoredPage[],
  optional: ScoredPage[],
  summary?: string
): string {
  const lines: string[] = []

  lines.push(`# ${siteName}`, "")

  if (summary) {
    lines.push(`> ${summary}`, "")
  }

  const sections = groupBySection(primary)

  for (const [section, pages] of sections) {
    if (pages.length === 0) continue
    lines.push(`## ${section}`, "")
    for (const page of pages) {
      lines.push(formatEntry(page))
    }
    lines.push("")
  }

  if (optional.length > 0) {
    lines.push("## Optional", "")
    for (const page of optional) {
      lines.push(formatEntry(page))
    }
    lines.push("")
  }

  return lines.join("\n").trimEnd() + "\n"
}

function formatEntry(page: ScoredPage): string {
  const url = page.mdUrl || page.url
  const title = page.title || url
  if (page.description && page.descriptionProvenance !== "none") {
    return `- [${title}](${url}): ${page.description}`
  }
  return `- [${title}](${url})`
}

function groupBySection(pages: ScoredPage[]): Map<string, ScoredPage[]> {
  const map = new Map<string, ScoredPage[]>()

  for (const page of pages) {
    const section = page.section || "Resources"
    if (!map.has(section)) map.set(section, [])
    map.get(section)!.push(page)
  }

  const sorted = new Map<string, ScoredPage[]>()
  for (const section of SECTION_ORDER) {
    if (map.has(section)) sorted.set(section, map.get(section)!)
  }
  for (const [section, ps] of map) {
    if (!sorted.has(section)) sorted.set(section, ps)
  }

  return sorted
}
