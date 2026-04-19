// Rate limiter. Upstash Redis when UPSTASH_REDIS_REST_* env vars are
// set (centralised state, survives instance churn and distributed
// IPs); in-memory token bucket otherwise (local dev only — resets on
// cold start). Both paths share the same `consumeRateLimit` signature.

import { Ratelimit } from "@upstash/ratelimit"
import { Redis } from "@upstash/redis"
import { debugLog } from "./log"

interface LimitConfig {
  /** Max burst size. */
  capacity: number
  /** Sustained rate (tokens / second). */
  refillPerSec: number
}

export interface LimitResult {
  allowed: boolean
  /** Seconds until at least one token is available (Retry-After header value). */
  retryAfterSec: number
  /** Tokens remaining after this attempt (or at time of check if denied). */
  remaining: number
}

// ─── Upstash path ────────────────────────────────────────────────────────────

// Redis client is built once per Fluid Compute instance. Absent when
// the env vars aren't set — callers fall back to the in-memory path.
const redis: Redis | null = (() => {
  if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) {
    return null
  }
  try {
    return Redis.fromEnv()
  } catch (err) {
    debugLog("rateLimit.redisInit", err)
    return null
  }
})()

// Cached per unique (capacity, refillPerSec) — one stable instance
// per config (anon + auth).
const limiterCache = new Map<string, Ratelimit>()
function getUpstashLimiter(cfg: LimitConfig): Ratelimit | null {
  if (!redis) return null
  const cacheKey = `${cfg.capacity}:${cfg.refillPerSec}`
  let limiter = limiterCache.get(cacheKey)
  if (!limiter) {
    // Upstash tokenBucket wants integer tokens-per-interval; we hold
    // sub-1/sec rates, so convert to tokens-per-hour.
    const perHour = Math.max(1, Math.round(cfg.refillPerSec * 3600))
    limiter = new Ratelimit({
      redis,
      limiter: Ratelimit.tokenBucket(perHour, "1 h", cfg.capacity),
      prefix: "rl",
      analytics: false,
    })
    limiterCache.set(cacheKey, limiter)
  }
  return limiter
}

// ─── In-memory fallback ──────────────────────────────────────────────────────

interface Bucket {
  tokens: number
  updatedAt: number // ms
}

const MAX_KEYS = 10_000
const buckets = new Map<string, Bucket>()

function consumeInMemory(key: string, cfg: LimitConfig): LimitResult {
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
  buckets.delete(key)
  buckets.set(key, b)
  while (buckets.size > MAX_KEYS) {
    const oldest = buckets.keys().next().value
    if (oldest === undefined) break
    buckets.delete(oldest)
  }
}

// ─── Public entrypoint ───────────────────────────────────────────────────────

export async function consumeRateLimit(
  key: string,
  cfg: LimitConfig,
): Promise<LimitResult> {
  const limiter = getUpstashLimiter(cfg)
  if (limiter) {
    try {
      const { success, remaining, reset } = await limiter.limit(key)
      if (success) return { allowed: true, retryAfterSec: 0, remaining }
      const retryAfterSec = Math.max(1, Math.ceil((reset - Date.now()) / 1000))
      return { allowed: false, retryAfterSec, remaining: 0 }
    } catch (err) {
      // Fail open on Upstash errors. A transient Redis outage
      // shouldn't take down all signups / crawls; better to permit
      // the request and revisit if it becomes frequent. Route through
      // console.warn directly (not the debugLog trace channel) so a
      // persistent misconfig — which *silently disables* rate limiting
      // platform-wide — is visible in the Vercel logs feed.
      const message = err instanceof Error ? err.message : String(err)
      console.warn(`[rateLimit] Upstash call failed, FAILING OPEN: ${message}`)
      return { allowed: true, retryAfterSec: 0, remaining: cfg.capacity }
    }
  }
  return consumeInMemory(key, cfg)
}

/**
 * Extract a best-effort client IP from Next's request. Behind Vercel
 * the canonical header is x-forwarded-for (first entry is the client).
 */
export function clientIp(req: { headers: Headers }): string {
  // `x-vercel-forwarded-for` is set by Vercel's edge and is tamper-
  // resistant — a client-supplied value is discarded. Prefer it so a
  // spoofed `X-Forwarded-For: 1.2.3.4` header can't unlock a fresh
  // rate-limit bucket per fake IP on production.
  const vercel = req.headers.get("x-vercel-forwarded-for")
  if (vercel) {
    const first = vercel.split(",")[0]?.trim()
    if (first) return first
  }
  // Non-Vercel envs (local dev, other hosts): fall back to
  // X-Forwarded-For / X-Real-IP. Locally this is still client-
  // controlled, which is fine since `npm run dev` isn't a trust
  // boundary.
  const xff = req.headers.get("x-forwarded-for")
  if (xff) {
    const first = xff.split(",")[0]?.trim()
    if (first) return first
  }
  const real = req.headers.get("x-real-ip")
  if (real) return real.trim()
  return "unknown"
}
