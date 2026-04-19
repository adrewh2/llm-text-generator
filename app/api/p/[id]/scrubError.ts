/**
 * Map internal pipeline errors to short user-facing messages. Prevents
 * us from leaking SSRF internals (resolved IPs, path hints) or stack
 * details that would signal "that attack got through to the crawler".
 */
export function scrubError(raw: string): string {
  const lower = raw.toLowerCase()
  if (lower.startsWith("unsafe url") || lower.includes("forbidden ip"))
    return "This URL can't be crawled."
  if (lower.includes("http 403") || lower.includes("bot challenge"))
    return "This site blocked our crawler."
  if (lower.startsWith("http ")) return "The site returned an error."
  if (lower.includes("timeout") || lower.includes("timed out"))
    return "The site took too long to respond."
  if (lower.includes("dns")) return "Couldn't resolve that domain."
  if (lower.includes("browser render failed")) return "We couldn't render this site."
  if (lower.includes("exceeded time budget")) return "Crawl took longer than our budget allows."
  return "Couldn't generate a result for this site."
}
