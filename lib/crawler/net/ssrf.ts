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
import { isForbiddenIpv4, isForbiddenIpv6 } from "./ipRanges"

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

  // WHATWG URL normalises default ports (`http://x:80` → `http://x`)
  // so `u.port` is "" when the default is in use. An explicit
  // non-default port lets an attacker point our crawler at
  // non-HTTP services on public IPs (Redis on 6379, memcached,
  // SMTP, SSH banners, etc.) that might accept HTTP-looking bytes
  // and leak state or mis-execute. Reject.
  if (u.port !== "") {
    throw new UnsafeUrlError(url, `non-default port not allowed (${u.port})`)
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
