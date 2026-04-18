// SSRF protection for user-supplied URLs.
//
// Every fetch the crawler makes against a target passes through
// assertSafeUrl(). Blocks:
//   - non-http(s) schemes
//   - hostnames that resolve (or literally are) private / loopback /
//     link-local / cloud-metadata IP ranges.
//
// DNS resolution is done via Node's dns/promises. Requests must be
// re-validated on every redirect hop — callers using `fetch` with
// redirect:"follow" should set redirect:"manual" and loop, or do a
// pre-flight DNS check each hop. For the MVP we validate the initial
// URL; most SSRF attempts go through a submitted URL pointing directly
// at an internal IP, which this blocks.

import { promises as dns } from "dns"
import { isIP } from "net"

export class UnsafeUrlError extends Error {
  constructor(public readonly url: string, reason: string) {
    super(`Unsafe URL (${reason}): ${url}`)
    this.name = "UnsafeUrlError"
  }
}

export async function assertSafeUrl(url: string): Promise<void> {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    throw new UnsafeUrlError(url, "invalid URL")
  }

  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new UnsafeUrlError(url, "only http(s) URLs are allowed")
  }

  const host = u.hostname
  if (!host) throw new UnsafeUrlError(url, "missing hostname")

  // If the hostname is already a literal IP, validate directly.
  if (isIP(host)) {
    if (isForbiddenIp(host)) throw new UnsafeUrlError(url, "forbidden IP range")
    return
  }

  // Common loopback literals that bypass DNS.
  const lowered = host.toLowerCase()
  if (lowered === "localhost" || lowered.endsWith(".localhost")) {
    throw new UnsafeUrlError(url, "loopback host")
  }

  // Resolve DNS and block if ANY answer is in a forbidden range.
  let addrs: string[] = []
  try {
    const lookups = await dns.lookup(host, { all: true, verbatim: true })
    addrs = lookups.map((a) => a.address)
  } catch {
    throw new UnsafeUrlError(url, "DNS lookup failed")
  }
  for (const a of addrs) {
    if (isForbiddenIp(a)) throw new UnsafeUrlError(url, `forbidden IP range (${a})`)
  }
}

/**
 * Returns true for private, loopback, link-local, multicast, cloud
 * metadata, and unspecified addresses (IPv4 and IPv6).
 */
export function isForbiddenIp(ip: string): boolean {
  const v = isIP(ip)
  if (v === 4) return isForbiddenIpv4(ip)
  if (v === 6) return isForbiddenIpv6(ip)
  return true // unparsable → assume forbidden
}

function isForbiddenIpv4(ip: string): boolean {
  const parts = ip.split(".").map((p) => parseInt(p, 10))
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p))) return true
  const [a, b] = parts

  if (a === 0)                                    return true // 0.0.0.0/8
  if (a === 10)                                   return true // 10.0.0.0/8
  if (a === 127)                                  return true // loopback
  if (a === 169 && b === 254)                     return true // link-local + AWS metadata 169.254.169.254
  if (a === 172 && b >= 16 && b <= 31)            return true // 172.16.0.0/12
  if (a === 192 && b === 168)                     return true // 192.168.0.0/16
  if (a === 192 && b === 0 && parts[2] === 0)     return true // 192.0.0.0/24 (IETF)
  if (a === 198 && (b === 18 || b === 19))        return true // benchmark
  if (a >= 224)                                   return true // multicast + reserved
  return false
}

function isForbiddenIpv6(ip: string): boolean {
  const lower = ip.toLowerCase()
  if (lower === "::" || lower === "::1")          return true // unspecified + loopback
  if (lower.startsWith("fe80:"))                  return true // link-local
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true // unique-local (fc00::/7)
  if (lower.startsWith("ff"))                     return true // multicast
  // IPv4-mapped: ::ffff:a.b.c.d — validate the embedded v4
  const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)
  if (mapped) return isForbiddenIpv4(mapped[1])
  return false
}
