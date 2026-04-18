// Simple in-memory rate limiter. Fluid Compute reuses function
// instances across requests, so one bucket survives across many
// invocations — good enough to stop casual abuse without pulling in
// a KV / Redis dependency. A serious actor with distributed IPs or a
// cold-start bypass would still slip through; swap for Upstash /
// Vercel KV when that becomes a real problem.
//
// Algorithm: token bucket. Each key has `capacity` tokens that refill
// at `refillPerSec` per second. Each hit costs one token. When the
// bucket is empty, requests are rejected.

interface Bucket {
  tokens: number
  updatedAt: number // ms
}

interface LimitConfig {
  /** Max burst size. */
  capacity: number
  /** Sustained rate (tokens / second). */
  refillPerSec: number
}

const MAX_KEYS = 10_000
const buckets = new Map<string, Bucket>()

export interface LimitResult {
  allowed: boolean
  /** Seconds until at least one token is available (Retry-After header value). */
  retryAfterSec: number
  /** Tokens remaining after this attempt (or at time of check if denied). */
  remaining: number
}

export function consumeRateLimit(key: string, cfg: LimitConfig): LimitResult {
  const now = Date.now()
  let b = buckets.get(key)
  if (!b) {
    b = { tokens: cfg.capacity, updatedAt: now }
    buckets.set(key, b)
  } else {
    const elapsed = (now - b.updatedAt) / 1000
    b.tokens = Math.min(cfg.capacity, b.tokens + elapsed * cfg.refillPerSec)
    b.updatedAt = now
  }

  if (b.tokens >= 1) {
    b.tokens -= 1
    touchLRU(key, b)
    return { allowed: true, retryAfterSec: 0, remaining: Math.floor(b.tokens) }
  }

  const needed = 1 - b.tokens
  const retryAfterSec = Math.max(1, Math.ceil(needed / cfg.refillPerSec))
  touchLRU(key, b)
  return { allowed: false, retryAfterSec, remaining: 0 }
}

function touchLRU(key: string, b: Bucket): void {
  // Map preserves insertion order → delete + set moves to tail.
  buckets.delete(key)
  buckets.set(key, b)
  while (buckets.size > MAX_KEYS) {
    const oldest = buckets.keys().next().value
    if (oldest === undefined) break
    buckets.delete(oldest)
  }
}

/**
 * Extract a best-effort client IP from Next's request. Behind Vercel
 * the canonical header is x-forwarded-for (first entry is the client).
 */
export function clientIp(req: { headers: Headers }): string {
  const xff = req.headers.get("x-forwarded-for")
  if (xff) {
    const first = xff.split(",")[0]?.trim()
    if (first) return first
  }
  const real = req.headers.get("x-real-ip")
  if (real) return real.trim()
  return "unknown"
}
