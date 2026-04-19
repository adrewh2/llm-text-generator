// Pure IP-range classifiers shared by the server SSRF guard and the
// client-side URL validator. No Node-only imports so this module is
// safe to include in a browser bundle.

export function isForbiddenIpv4(ip: string): boolean {
  const parts = ip.split(".").map((p) => parseInt(p, 10))
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p))) return true
  const [a, b] = parts

  if (a === 0)                                    return true // 0.0.0.0/8
  if (a === 10)                                   return true // 10.0.0.0/8
  if (a === 100 && b >= 64 && b <= 127)           return true // 100.64.0.0/10 CGNAT (RFC 6598)
  if (a === 127)                                  return true // loopback
  if (a === 169 && b === 254)                     return true // link-local + AWS metadata 169.254.169.254
  if (a === 172 && b >= 16 && b <= 31)            return true // 172.16.0.0/12
  if (a === 192 && b === 168)                     return true // 192.168.0.0/16
  if (a === 192 && b === 0 && parts[2] === 0)     return true // 192.0.0.0/24 (IETF)
  if (a === 198 && (b === 18 || b === 19))        return true // benchmark
  if (a >= 224)                                   return true // multicast + reserved
  return false
}

export function isForbiddenIpv6(ip: string): boolean {
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
