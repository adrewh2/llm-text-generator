import type { SiteGenre } from "./types"

export function detectGenre(homepageHtml: string, urls: string[]): SiteGenre {
  const text = homepageHtml.toLowerCase()
  const urlText = urls.join(" ").toLowerCase()

  // E-commerce: strong signals
  const ecommercePatterns = [
    /\badd to cart\b|\bbuy now\b|\bshopping cart\b|\bcheckout\b/,
    /\bfree shipping\b|\breturn policy\b|\bshopping bag\b/,
  ]
  const ecommerceUrlPatterns = [/\/collections\/|\/products\/|\/shop\/|\/cart\b/]
  const ecommerceScore = [
    ...ecommercePatterns.filter((p) => p.test(text)),
    ...ecommerceUrlPatterns.filter((p) => p.test(urlText)),
  ].length
  if (ecommerceScore >= 2) return "ecommerce"

  // Developer docs
  const docsTextPatterns = [
    /\bdocumentation\b|\bapi reference\b|\bsdk\b|\bgetting started\b|\bquickstart\b/,
    /npm install|pip install|brew install|import |require\(/,
  ]
  const docsUrlPatterns = [/\/docs\/|\/api\/|\/reference\/|\/guide\//]
  const docsScore = [
    ...docsTextPatterns.filter((p) => p.test(text)),
    ...docsUrlPatterns.filter((p) => p.test(urlText)),
  ].length
  if (docsScore >= 2) return "developer_docs"

  // Blog/publication
  const blogUrlCount = urls.filter((u) => /\/blog\/|\/post\/|\/article\//.test(u)).length
  const blogScore = [
    /\bpublished\b|\bauthor\b|\bbyline\b|\bsubscribe\b|\bnewsletter\b/,
    /\bread more\b|\bfull article\b|\bmin read\b/,
  ].filter((p) => p.test(text)).length
  if (blogUrlCount > urls.length * 0.25 || blogScore >= 2) return "blog_publication"

  // Institutional
  const institutionalScore = [
    /\bprogram\b|\bfaculty\b|\bresearch\b|\bdepartment\b|\bcurriculum\b|\benrollment\b/,
    /\bnonprofit\b|\bngo\b|\bfoundation\b|\bgrant\b|\bdonat/,
  ].filter((p) => p.test(text)).length
  if (institutionalScore >= 2) return "institutional"

  // Personal site
  const personalScore = [
    /\bportfolio\b|\bfreelance\b|\bhire me\b|\bresume\b|\bmy work\b|\babout me\b/,
    /\bdesigner\b|\bdeveloper\b|\bphotographer\b|\bwriter\b|\bconsultant\b/,
  ].filter((p) => p.test(text)).length
  if (personalScore >= 2) return "personal_site"

  return "generic"
}
