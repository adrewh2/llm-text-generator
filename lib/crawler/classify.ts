import type { PageType } from "./types"

const PATH_RULES: Array<{ type: PageType; patterns: RegExp[] }> = [
  {
    type: "api",
    patterns: [/\/api[-/](reference|docs?)?/i, /\/reference\//i, /\/sdk\//i, /\/endpoints?\//i],
  },
  {
    type: "doc",
    patterns: [
      /\/docs?\//i, /\/documentation\//i, /\/guide\//i, /\/tutorial\//i,
      /\/learn\//i, /\/manual\//i, /\/handbook\//i, /\/quickstart/i,
      /\/getting[-_]?started/i, /\/introduction/i,
    ],
  },
  {
    type: "example",
    patterns: [
      /\/examples?\//i, /\/demos?\//i, /\/showcase\//i,
      /\/samples?\//i, /\/cookbook\//i, /\/recipes?\//i, /\/templates?\//i,
    ],
  },
  {
    type: "blog",
    patterns: [/\/blog\//i, /\/posts?\//i, /\/articles?\//i, /\/journal\//i, /\/writing\//i],
  },
  {
    type: "changelog",
    patterns: [/\/changelog/i, /\/releases?\//i, /\/whatsnew/i, /\/history\/?$/i, /\/updates?\//i],
  },
  {
    type: "about",
    patterns: [
      /\/about([-/]us)?\/?$/i, /\/team\/?$/i, /\/company\/?$/i,
      /\/mission\/?$/i, /\/story\/?$/i, /\/careers?\/?/i, /\/jobs?\/?/i,
    ],
  },
  {
    type: "product",
    patterns: [
      /\/products?\//i, /\/collections?\//i, /\/catalog\//i,
      /\/shop\//i, /\/store\//i, /\/items?\//i,
    ],
  },
  {
    type: "pricing",
    patterns: [/\/pricing\/?$/i, /\/plans?\/?$/i, /\/subscription/i],
  },
  {
    type: "support",
    patterns: [/\/support\//i, /\/help\//i, /\/faq\/?$/i, /\/contact\/?$/i],
  },
  {
    type: "policy",
    patterns: [/\/privac/i, /\/terms[-/]?of/i, /\/legal\//i, /\/policies?\//i, /\/cookies?\//i],
  },
  {
    type: "news",
    patterns: [/\/press\//i, /\/press-releases?\//i, /\/media\//i, /\/announcements?\//i],
  },
  {
    type: "program",
    patterns: [/\/programs?\//i, /\/courses?\//i, /\/curriculum\//i],
  },
  {
    type: "project",
    patterns: [/\/projects?\//i, /\/work\//i, /\/portfolio\//i, /\/case[-_]?studies?\//i],
  },
]

export function classifyPage(url: string, title?: string): PageType {
  try {
    const path = new URL(url).pathname.toLowerCase()

    for (const { type, patterns } of PATH_RULES) {
      if (patterns.some((p) => p.test(path))) return type
    }

    if (title) {
      const t = title.toLowerCase()
      if (/\bapi\b|reference|endpoint/.test(t)) return "api"
      if (/\btutorial\b|\bguide\b|\bdoc\b|\bmanual\b|quickstart/.test(t)) return "doc"
      if (/\bexample\b|\bdemo\b|\bsample\b|\btemplate\b/.test(t)) return "example"
      if (/changelog|release notes|what.?s new/.test(t)) return "changelog"
      if (/\bpricing\b|\bplans?\b/.test(t)) return "pricing"
      if (/\babout\b|\bteam\b|\bcompany\b/.test(t)) return "about"
      if (/\bblog\b|\bpost\b|\barticle\b/.test(t)) return "blog"
    }
  } catch {}

  return "other"
}
