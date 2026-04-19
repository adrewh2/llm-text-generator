import type { SiteGenre } from "./types"

// Regex-only detection on homepage HTML + URL list. Runs once per
// crawl after the homepage fetch; total cost is tens of ms on a
// large homepage (dominated by `text.toLowerCase()` over the body),
// single-digit ms or less when a hostname short-circuit fires.
//
// Priority matters: more specific genres must check BEFORE their
// broader siblings (government before corporate, api_reference
// before developer_docs, media_publication before blog). First match
// wins — add new genres high in the chain and use strict signals to
// avoid swallowing neighbours.
//
// URL patterns treat path segments as "segment-at-path-boundary"
// rather than requiring a trailing slash. `normalizeUrl` in `url.ts`
// strips trailing slashes, so `/section/politics` is the shape that
// actually arrives here — matching on `/politics/` alone misses it.
export function detectGenre(homepageHtml: string, urls: string[]): SiteGenre {
  const text = homepageHtml.toLowerCase()
  const urlText = urls.join(" ").toLowerCase()

  const hostname = ((): string => {
    try { return new URL(urls[0] ?? "").hostname } catch { return "" }
  })()

  const urlCount = Math.max(1, urls.length)
  const urlFrac = (pattern: RegExp) =>
    urls.filter((u) => pattern.test(u)).length / urlCount

  const matchCount = (patterns: RegExp[], corpus: string) =>
    patterns.filter((p) => p.test(corpus)).length

  // Path-segment matcher: "/docs" (end of URL), "/docs/" (dir), "/docs?foo".
  // Callers pass the alternation body — e.g. segAt("docs|api") matches
  // both `https://x.com/docs` and `https://x.com/api/v1`.
  const segAt = (alternation: string) =>
    new RegExp(`/(?:${alternation})(?:/|\\?|#|$)`, "i")

  // Shared fact: how much of the URL space looks like docs/api/reference?
  // Used as a disqualifier for "no-docs" genres (marketing_site, saas_product).
  const docsSegment = segAt("docs?|api|reference|guide")
  const docsUrlCount = urls.filter((u) => docsSegment.test(u)).length

  // ─── Landing page (very few URLs — check early) ────────────────
  if (urlCount <= 4 && matchCount([
    /\bcoming soon\b|\blaunching soon\b|\bbeta\b.*\b(signup|waitlist)\b/,
    /\bnotify me\b|\bjoin the waitlist\b|\bearly access\b/,
    /\bget updates\b|\bsubscribe\b.*\bnewsletter\b/,
  ], text) >= 1) return "landing_page"

  // ─── Government ─────────────────────────────────────────────────
  if (/\.gov(\.[a-z]{2,3})?$/.test(hostname) || /\.mil$/.test(hostname)) return "government"
  if (matchCount([
    /\bfederal register\b|\bdepartment of\b.*\b(health|labor|defense|justice|education|state)\b/,
    /\b(city|county|state) of\b.*\b(services?|government|offices?)\b/,
    /\bpublic records\b|\bforms and applications\b|\bmunicipal (code|services?)\b/,
    /\boffice of the\b.*\b(mayor|governor|secretary|commissioner|attorney)\b/,
  ], text) >= 2) return "government"

  // ─── Academic research ──────────────────────────────────────────
  if (/\.edu(\.[a-z]{2,3})?$/.test(hostname) || /\.ac\.[a-z]{2,3}$/.test(hostname)) return "academic_research"
  if (matchCount([
    /\bfaculty\b.*\b(research|publications?)\b|\badmissions\b.*\b(graduate|undergraduate)\b/,
    /\bcurriculum\b|\bcourse catalog\b|\bsyllab(us|i)\b/,
    /\bphd\b|\bdissertation\b|\bpeer[- ]reviewed\b|\bscholarly\b/,
    /\blaborator(y|ies)\b.*\b(principal|director)\b|\bresearch group\b/,
  ], text) >= 2) return "academic_research"

  // ─── API reference (subtype of developer_docs — check first) ───
  const apiUrlRatio = urlFrac(segAt("api|reference|endpoints?|sdk"))
  if (apiUrlRatio > 0.35) return "api_reference"
  if (apiUrlRatio > 0.15 && matchCount([
    /\bapi reference\b|\brest api\b|\bgraphql\b/,
    /\bendpoints?\b|\brequest\s+(parameters?|body|headers?)\b/,
    /\b(bearer|oauth|api key)\b.*\bauthentication\b/,
  ], text) >= 2) return "api_reference"

  // ─── Technical knowledge base (MDN / W3C / RFC / standards shape) ──
  // Distinguishes authoritative technical reference from customer-support
  // help centers — both use similar URL paths but content differs.
  if (matchCount([
    /\b(specification|standard|rfc\s+\d+|w3c|iana|ietf)\b/,
    /\bnormative reference\b|\bconformance\b|\btechnical (reference|standard)\b/,
    /\bbrowser compatibility\b|\bimplementation notes?\b/,
  ], text) >= 2) return "technical_knowledge_base"

  // ─── Help center (customer-support flavour) ────────────────────
  const kbUrlRatio = urlFrac(segAt("help|support|faq|kb|knowledge(?:-|_)?base"))
  if (kbUrlRatio > 0.3) return "help_center"
  if (kbUrlRatio > 0.1 && matchCount([
    /\bhelp (center|article)\b|\bsupport portal\b/,
    /\bfrequently asked\b|\btroubleshooting\b|\bcontact support\b/,
    /\bsubmit a (ticket|request)\b|\bhow do i\b.*\?/,
  ], text) >= 2) return "help_center"

  // ─── Developer docs ─────────────────────────────────────────────
  if (docsUrlCount > urlCount * 0.2) return "developer_docs"
  if (matchCount([
    /\bdocumentation\b|\bapi reference\b|\bsdk\b|\bgetting started\b|\bquickstart\b|\binstallation\b/,
    /npm install|pip install|brew install|yarn add|cargo add|go get /,
  ], text) + matchCount([docsSegment], urlText) >= 2) return "developer_docs"

  // ─── Marketplace (before ecommerce — requires multi-seller signals) ──
  if (matchCount([
    /\bbecome a (seller|host|vendor)\b|\blist your (property|space|product)\b/,
    /\b(verified|top[- ]rated) (seller|host|vendor)\b/,
    /\bmarketplace\b.*\b(sellers?|listings?)\b/,
    /\breviews? from\b.*\b(guests?|buyers?|customers?)\b/,
  ], text) >= 2) return "marketplace"

  // ─── Ecommerce store ────────────────────────────────────────────
  if (matchCount([
    /\badd to cart\b|\bbuy now\b|\bshopping cart\b|\bcheckout\b/,
    /\bfree shipping\b|\breturn policy\b|\bshopping bag\b|\bin stock\b/,
  ], text) + matchCount([segAt("collections|products|shop|cart")], urlText) >= 2) return "ecommerce_store"

  // ─── Directory listing (Yelp / Yellow Pages / Zillow / Crunchbase shape) ──
  const listingUrlRatio = urlFrac(segAt("businesses?|places?|people|companies|listings?|profiles?|directory"))
  if (listingUrlRatio > 0.25) return "directory_listing"
  if (matchCount([
    /\bdirectory\b.*\b(businesses?|listings?|members?)\b/,
    /\bfind a\b.*\b(business|doctor|lawyer|provider|dentist|agent)\b/,
    /\brated\s+\d(\.\d)?\s+stars?\b.*\bbased on\b/,
  ], text) >= 2) return "directory_listing"

  // ─── Media publication (before blog — stricter signals) ────────
  const mediaUrlRatio = urlFrac(segAt("politics|world|business|sports|opinion|technology|arts|style|entertainment|culture"))
  // News-specific text signals. Bylines used to be in this list as a
  // case-sensitive pattern, which silently never matched against our
  // lowercased `text` — use HTML-structural hrefs instead (`/by/slug`
  // is standard on NYT, WaPo, and most modern CMS-driven outlets).
  const mediaTextScore = matchCount([
    /href=["']\/by\/[a-z]/,                          // `/by/author-slug` byline links
    /\bbreaking news\b|\bnewsroom\b|\bwire (report|service)\b/,
    /\bsubscriber[- ]only\b|\b(digital|print) subscription\b/,
    /\bupdated\s+\d+\s+(minute|hour|hr)s?\s+ago\b/,
  ], text)
  if ((mediaUrlRatio > 0.2 || mediaTextScore >= 2) && docsUrlCount < urlCount * 0.05) return "media_publication"

  // ─── Blog ───────────────────────────────────────────────────────
  // Tightened: require URL-structural evidence of a blog. Text alone
  // ("newsletter", "read more") fires on marketing sites too.
  const blogSegment = segAt("blog|posts?|articles?")
  const blogUrlCount = urls.filter((u) => blogSegment.test(u)).length
  const blogUrlRatio = blogUrlCount / urlCount
  const blogTextScore = matchCount([
    /\bpublished\b|\bauthor\b|\bbyline\b|\bnewsletter\b/,
    /\bread more\b|\bfull article\b|\bmin read\b/,
  ], text)
  if (docsUrlCount < urlCount * 0.1 && (
    blogUrlRatio > 0.2 ||
    (blogUrlCount > 0 && blogTextScore >= 2)
  )) return "blog"

  // ─── SaaS product (app with login + pricing + features, no docs) ──
  // Checked before event/blog-adjacent genres because product sites
  // commonly mention conferences they host (e.g. "Stripe Sessions
  // 2024") on their homepage — text-only event signals would claim
  // them otherwise.
  if (docsUrlCount === 0 && matchCount([
    /\blog in\b|\blogin\b|\bsign in\b/,
    /\b(start|try)\s+(free|for free|trial|now)\b|\bfree\s+plan\b/,
    /\bpricing\b.*\b(plans?|per (month|year|user|seat))\b/,
    /\bbook (a )?demo\b|\bschedule (a )?call\b|\btalk to sales\b/,
  ], text) >= 3) return "saas_product"

  // ─── Marketing site (no docs, no app — pure marketing) ─────────
  if (docsUrlCount === 0 && matchCount([
    /\bfeatures?\b.*\bintegrations?\b|\btrusted by\b.*\b(leading|\d+\s+(companies|teams))\b/,
    /\bpricing\b|\bget a quote\b|\bcontact sales\b/,
    /\btestimonials?\b|\bcustomer stor(y|ies)\b/,
    /\b(start|try|get)\s+(free|for free|started|a demo)\b/,
  ], text) >= 2) return "marketing_site"

  // ─── Community forum ────────────────────────────────────────────
  if (matchCount([
    /\breplies?\b.*\bthread\b|\b(latest|trending) topics?\b|\bdiscussion board\b/,
    /\bforum\b.*\b(members?|rules|guidelines)\b/,
    /\bposted by\b.*\b\d+\s+(minute|hour|day)s?\s+ago\b/,
    /powered by (discourse|phpbb|vbulletin|xenforo)/,
  ], text) >= 2) return "community_forum"

  // ─── Social platform ────────────────────────────────────────────
  if (matchCount([
    /\bfollowers?\b.*\bfollowing\b|\btimeline\b.*\b(home|for you)\b/,
    /\b(your|public) feed\b|\bdirect messages?\b/,
    /\b(post|share) (a|an|your)\s+(status|update|photo|video)\b/,
    /\b(like|comment|repost|retweet|reshare)s?\b.*\bprofile\b/,
  ], text) >= 2) return "social_platform"

  // ─── Event site ─────────────────────────────────────────────────
  // Requires URL-structural evidence (schedule / speakers / sessions
  // paths) OR a very strong text signal cluster. Loosening either
  // catches too many product sites that mention a conference.
  const eventUrlRatio = urlFrac(segAt("schedule|speakers?|sessions?|agenda|venue|register"))
  if (eventUrlRatio > 0.15 || matchCount([
    /\bconference\b.*\b(20\d\d|agenda|schedule|speakers?)\b/,
    /\bkeynote\b|\bregister(ed)? (for|now)\b.*\bevent\b|\btickets?\b.*\b(available|sold out)\b/,
    /\bvenue\b.*\b(address|location)\b|\bday\s+(one|two|three|1|2|3)\s+agenda\b/,
    /\bcall for (papers|proposals|speakers)\b|\bworkshop\b.*\bspeakers?\b/,
  ], text) >= 3) return "event_site"

  // ─── Entertainment ──────────────────────────────────────────────
  if (matchCount([
    /\bwatch\s+(now|on demand|online)\b|\bstream(ing)?\b.*\b(movies?|shows?|series|music)\b/,
    /\bsoundtrack\b|\btracklist\b|\balbum\b.*\brelease\b|\bep(isode)?\s+\d+\b|\bseason\s+\d+\b/,
    /\bgame\s+(trailer|features|gameplay)\b|\bplatform\b.*\b(ps5|xbox|switch|steam|pc)\b/,
    /\bnow playing\b|\bcoming soon\b.*\b(theat(er|re)s?|release)\b/,
  ], text) >= 2) return "entertainment"

  // ─── Nonprofit (before corporate — stricter signals) ───────────
  if (matchCount([
    /\b501\(c\)\(3\)\b|\btax[- ]deductible\b/,
    /\bdonate\b.*\b(now|today|monthly|one[- ]time)\b|\brecurring (donation|gift)\b/,
    /\bcharit(y|able)\b|\bfoundation\b.*\bmission\b/,
    /\bgrants? (program|funding)\b|\bour impact\b|\bbeneficiar(y|ies)\b/,
  ], text) >= 2) return "nonprofit"

  // ─── Corporate (company website: investor relations, leadership) ──
  // Ticker pattern matches lowercased text — exchange codes appear
  // lowercased ("nasdaq:aapl") in investor-relations copy often enough
  // that restricting to the uppercase form would miss the real signal.
  if (matchCount([
    /\binvestor relations\b|\bannual report\b|\bearnings (call|release|report)\b/,
    /\bboard of directors\b|\bexecutive (team|leadership)\b|\bshareholders?\b/,
    /\b(press|media) (release|kit)\b.*\b(company|corporation)\b/,
    /\b(nasdaq|nyse|lse|tsx):\s*[a-z]+\b/,
  ], text) >= 2) return "corporate"

  // ─── Portfolio ──────────────────────────────────────────────────
  if (matchCount([
    /\b(our|selected|recent|featured) (work|projects?|case studies)\b/,
    /\bclient list\b|\bcase studies\b/,
    /\bdesign studio\b|\b(creative|digital) agency\b/,
  ], text) >= 2) return "portfolio"

  // ─── Personal site ──────────────────────────────────────────────
  if (matchCount([
    /\bportfolio\b|\bfreelance\b|\bhire me\b|\bresume\b|\bmy work\b|\babout me\b/,
    /\b(i'?m|i am) a\b.*\b(designer|developer|photographer|writer|consultant|engineer|artist)\b/,
  ], text) >= 2) return "personal"

  return "generic"
}
