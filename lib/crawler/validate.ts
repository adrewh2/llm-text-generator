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
  const firstContent = lines.find((l) => l.trim() !== "")
  if (!firstContent?.startsWith("# ")) {
    errors.push({ line: 1, message: "File must begin with an H1 heading (# Title)" })
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

  // Sections must have entries; track duplicates
  let currentSection: string | null = null
  let sectionHasEntries = false
  const seenUrls = new Set<string>()

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]

    if (/^## /.test(line)) {
      if (currentSection !== null && !sectionHasEntries) {
        errors.push({ line: i, message: `Section "${currentSection}" has no list entries` })
      }
      currentSection = line.slice(3).trim()
      sectionHasEntries = false
      continue
    }

    if (line.startsWith("- [")) {
      sectionHasEntries = true
      const match = line.match(/^- \[([^\]]+)\]\(([^)]+)\)/)
      if (!match) {
        errors.push({ line: i + 1, message: `Invalid list entry: "${line.trim()}"` })
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

  if (currentSection !== null && !sectionHasEntries) {
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
