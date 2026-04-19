import { safeFetch } from "../net/safeFetch"
import { USER_AGENT as FETCH_USER_AGENT } from "./fetchPage"

// Name used when matching `User-agent:` directives in robots.txt.
// Keep this as the bare token (no version/URL suffix) — some sites
// write `User-agent: LlmsTxtGenerator` and expect exact-token match.
export const ROBOTS_USER_AGENT = "LlmsTxtGenerator"

export interface RobotsData {
  disallowed: string[]
  sitemaps: string[]
  crawlDelay?: number
}

export async function fetchRobots(baseUrl: string): Promise<RobotsData> {
  const result: RobotsData = { disallowed: [], sitemaps: [] }

  try {
    const robotsUrl = new URL("/robots.txt", baseUrl).toString()
    const res = await safeFetch(robotsUrl, {
      signal: AbortSignal.timeout(10000),
      headers: { "User-Agent": FETCH_USER_AGENT },
    })
    if (!res.ok) return result
    const text = await res.text()
    parseRobots(text, result)
  } catch {
    // Non-fatal
  }

  return result
}

function parseRobots(text: string, result: RobotsData): void {
  const lines = text.split("\n")
  let ourAgentActive = false
  let starAgentActive = false
  const starDisallowed: string[] = []
  let starDelay: number | undefined
  let hasOurAgentRules = false

  for (const rawLine of lines) {
    const line = rawLine.trim()

    if (line === "" || line.startsWith("#")) {
      if (line === "") {
        ourAgentActive = false
        starAgentActive = false
      }
      continue
    }

    const colonIdx = line.indexOf(":")
    if (colonIdx === -1) continue

    const key = line.slice(0, colonIdx).trim().toLowerCase()
    const value = line.slice(colonIdx + 1).trim()

    if (key === "user-agent") {
      ourAgentActive = value.toLowerCase() === ROBOTS_USER_AGENT.toLowerCase()
      starAgentActive = value === "*"
      if (ourAgentActive) hasOurAgentRules = true
    }

    if (key === "sitemap" && value) {
      if (!result.sitemaps.includes(value)) result.sitemaps.push(value)
    }

    if (key === "disallow" && value) {
      if (ourAgentActive) result.disallowed.push(value)
      if (starAgentActive) starDisallowed.push(value)
    }

    if (key === "crawl-delay") {
      const delay = parseFloat(value)
      if (!isNaN(delay)) {
        if (ourAgentActive) result.crawlDelay = delay
        if (starAgentActive && !hasOurAgentRules) starDelay = delay
      }
    }
  }

  if (!hasOurAgentRules) {
    result.disallowed = starDisallowed
    result.crawlDelay = starDelay
  }
}

export function isAllowed(url: string, disallowed: string[]): boolean {
  if (disallowed.length === 0) return true
  try {
    const path = new URL(url).pathname
    return !disallowed.some((rule) => {
      if (rule === "") return false
      if (rule === "/") return true
      return path.startsWith(rule)
    })
  } catch {
    return false
  }
}

/** Returns true if robots.txt contains a blanket Disallow: / rule. */
export function hasFullDisallow(disallowed: string[]): boolean {
  return disallowed.includes("/")
}
