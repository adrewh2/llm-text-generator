// Language-preference helpers. The pipeline detects the site's
// primary language from the homepage's `<html lang>` attribute and
// uses it as the reference for prioritization: pages whose URL path
// or own lang attribute indicates a *different* language than the
// site's primary are penalized in scoring. This keeps apple.com's
// English content on top while still letting a Japanese-first site
// like nikkei.com generate a useful llms.txt in its own language.

// ISO 639-1 codes we recognize as locale prefixes in URL paths. This
// is the allowlist the URL-shape detector compares against — anything
// that isn't in here stays neutral (a /us/ or /ca/ segment on an
// English regional page shouldn't be mis-read as Catalan or Ukrainian).
const KNOWN_LOCALE_CODES = new Set([
  "ar", "bg", "bn", "cs", "da", "de", "el", "en", "es", "et", "fa", "fi",
  "fr", "gu", "he", "hi", "hr", "hu", "id", "is", "it", "ja", "kn",
  "ko", "lt", "lv", "ml", "mr", "ms", "nl", "no", "pa", "pl", "pt",
  "ro", "ru", "sk", "sl", "sv", "sw", "ta", "te", "th", "tl", "tr",
  "ur", "vi", "zh",
])

/**
 * The 2-letter base of a language tag, lowercased. `en-US` → `en`,
 * `zh_CN` → `zh`. Returns null when the input is empty.
 */
export function baseLangCode(lang: string | undefined | null): string | null {
  if (!lang) return null
  const base = lang.toLowerCase().split(/[-_]/)[0]
  return base || null
}

/**
 * Returns the language code implied by a URL's first path segment
 * (e.g. `/ja/iphone` → `ja`, `/zh-cn/iphone` → `zh`, `/ae-ar/iphone`
 * → `ar`). Handles both `lang-region` and `region-lang` orderings
 * (Apple uses the latter: `/ae-ar/` = UAE-Arabic). Returns null when
 * neither half of the segment is a known ISO 639-1 code, so generic
 * prefixes like `/docs/` or `/us/` stay neutral.
 */
export function urlLocaleCode(url: string): string | null {
  try {
    const first = new URL(url).pathname.split("/")[1]?.toLowerCase()
    if (!first) return null
    // 2–3 letter tokens only — skip longer path segments like
    // "sitemap" or "products" that wouldn't survive the code lookup
    // but shouldn't be split by every hyphen either.
    if (!/^[a-z]{2,3}(?:[-_][a-z0-9]{2,4})?$/.test(first)) return null
    for (const part of first.split(/[-_]/)) {
      if (KNOWN_LOCALE_CODES.has(part)) return part
    }
    return null
  } catch {
    return null
  }
}

/**
 * True when the URL's locale prefix OR the page's own `<html lang>`
 * attribute indicates a language different from the site's primary.
 * Pages with no locale signal are treated as matching (safe default —
 * most non-localized pages on a site share its language).
 */
export function isOffPrimaryLanguage(
  url: string,
  pageLang: string | undefined | null,
  primaryLang: string,
): boolean {
  const urlLocale = urlLocaleCode(url)
  if (urlLocale && urlLocale !== primaryLang) return true
  const pageBase = baseLangCode(pageLang)
  if (pageBase && pageBase !== primaryLang) return true
  return false
}
