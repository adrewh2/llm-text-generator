import { altWwwForm, normalizeUrl } from "./url"
import { safeFetch } from "./safeFetch"

// Resolves a submitted URL to its canonical form by probing both
// `www.` and non-`www.` variants in parallel.
// - If both forms resolve to the same URL, the server expressed a
//   preference (e.g. speedtest.net → www.speedtest.net); honor it.
// - If they resolve independently, no preference exists (e.g.
//   speedtest.com); strip `www.` as dedup convention.
export async function resolveCanonicalUrl(submitted: string): Promise<string> {
  const probe = async (u: string): Promise<string> => {
    try {
      const res = await safeFetch(u, {
        method: "HEAD",
        signal: AbortSignal.timeout(5000),
      })
      return res.url || u
    } catch {
      return u
    }
  }

  const [resolvedA, resolvedB] = await Promise.all([
    probe(submitted),
    probe(altWwwForm(submitted)),
  ])

  const nA = normalizeUrl(resolvedA) || resolvedA
  const nB = normalizeUrl(resolvedB) || resolvedB
  if (nA === nB) return nA

  // Both forms serve independently; strip `www.` as dedup convention.
  const stripped = new URL(resolvedA)
  stripped.hostname = stripped.hostname.replace(/^www\./, "")
  return normalizeUrl(stripped.toString()) || stripped.toString()
}
