export interface ValidationError {
  line?: number
  message: string
}

export interface ValidationResult {
  valid: boolean
  errors: ValidationError[]
}

export function validateLlmsTxt(content: string): ValidationResult {
  const errors: ValidationError[] = []
  const lines = content.split("\n")

  // Must start with H1
  const firstContentIdx = lines.findIndex((l) => l.trim() !== "")
  const firstContent = firstContentIdx >= 0 ? lines[firstContentIdx] : ""
  if (!firstContent.startsWith("# ")) {
    // An empty / whitespace-only file has firstContentIdx=-1; without
    // the guard the error would report "Line 0", which is confusing.
    errors.push({
      line: firstContentIdx >= 0 ? firstContentIdx + 1 : undefined,
      message: "File must begin with an H1 heading (# Title)",
    })
  }

  // Only one H1
  const h1Count = lines.filter((l) => /^# /.test(l)).length
  if (h1Count > 1) {
    errors.push({ message: "File must contain exactly one H1 heading" })
  }

  // No H3+
  lines.forEach((line, i) => {
    if (/^#{3,} /.test(line)) {
      errors.push({ line: i + 1, message: `H3+ headings are not allowed: "${line.trim()}"` })
    }
  })

  // Locate structural markers
  const firstH2Idx = lines.findIndex((l) => /^## /.test(l))
  const blockquoteIdx = lines.findIndex((l) => l.startsWith("> "))

  // Blockquote must appear before first H2 section
  if (blockquoteIdx !== -1 && firstH2Idx !== -1 && blockquoteIdx > firstH2Idx) {
    errors.push({ line: blockquoteIdx + 1, message: "Blockquote summary must appear before the first H2 section" })
  }

  // Preamble (between end of blockquote/H1 and first H2) must contain no headings
  const preambleEnd = firstH2Idx === -1 ? lines.length : firstH2Idx
  for (let i = firstContentIdx + 1; i < preambleEnd; i++) {
    if (/^#{1,6} /.test(lines[i])) {
      errors.push({ line: i + 1, message: "Preamble (before first H2) must not contain headings" })
    }
  }

  // ## Optional must appear at most once and only as the last H2 section
  const optionalIndices = lines.reduce<number[]>((acc, l, i) => {
    if (l.trim() === "## Optional") acc.push(i)
    return acc
  }, [])
  if (optionalIndices.length > 1) {
    errors.push({ message: '## Optional section must appear at most once' })
  }
  if (optionalIndices.length === 1) {
    const lastH2Idx = lines.reduce((last, l, i) => (/^## /.test(l) ? i : last), -1)
    if (optionalIndices[0] !== lastH2Idx) {
      errors.push({ line: optionalIndices[0] + 1, message: '## Optional must be the last H2 section' })
    }
  }

  // Sections must have entries; list items must be valid; track duplicates
  let currentSection: string | null = null
  let sectionHasEntries = false
  let inSection = false
  const seenUrls = new Set<string>()

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]

    if (/^## /.test(line)) {
      if (inSection && !sectionHasEntries) {
        errors.push({ line: i, message: `Section "${currentSection}" has no list entries` })
      }
      currentSection = line.slice(3).trim()
      sectionHasEntries = false
      inSection = true
      continue
    }

    if (!inSection) continue

    if (line.startsWith("- ")) {
      // All list items inside H2 sections must be in `- [name](url)` format
      if (!line.startsWith("- [")) {
        errors.push({ line: i + 1, message: `List entries must use link format: "- [name](url)" — got: "${line.trim()}"` })
        sectionHasEntries = true
        continue
      }
      sectionHasEntries = true
      const match = line.match(/^- \[([^\]]+)\]\(([^)]+)\)/)
      if (!match) {
        errors.push({ line: i + 1, message: `Invalid list entry format: "${line.trim()}"` })
      } else {
        const url = match[2]
        if (!isValidAbsoluteUrl(url)) {
          errors.push({ line: i + 1, message: `Invalid or relative URL: "${url}"` })
        }
        if (seenUrls.has(url)) {
          errors.push({ line: i + 1, message: `Duplicate URL: "${url}"` })
        }
        seenUrls.add(url)
      }
    }
  }

  if (inSection && !sectionHasEntries) {
    errors.push({ message: `Section "${currentSection}" has no list entries` })
  }

  return { valid: errors.length === 0, errors }
}

function isValidAbsoluteUrl(url: string): boolean {
  try {
    const u = new URL(url)
    return u.protocol === "http:" || u.protocol === "https:"
  } catch {
    return false
  }
}
