// Rate limiter. Two paths:
//
//   - Upstash Redis (preferred in production). Activated when both
//     UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN are set.
//     State is centralized so instance churn / region failover / cold
//     starts can't reset a user's bucket, and the bucket also holds
//     up against distributed IPs hitting us across instances.
//
//   - In-memory token bucket (fallback). Used when the Upstash env
//     vars are absent — keeps `npm run dev` working without requiring
//     a network dependency. On Vercel Fluid Compute a single instance
//     reuses memory across requests, which is good enough to stop
//     casual abuse but won't hold up against attackers aiming at cold
//     starts or autoscale events.
//
// Both paths speak the same `consumeRateLimit(key, cfg) → LimitResult`
// interface. Callers `await` regardless of which one's active.

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

// Ratelimit instances are keyed by (capacity, refillPerSec) so the
// two configs we ship today (anon, auth) each produce one stable
// instance per process. Cheap to hold — they wrap the Redis client.
const limiterCache = new Map<string, Ratelimit>()
function getUpstashLimiter(cfg: LimitConfig): Ratelimit | null {
  if (!redis) return null
  const cacheKey = `${cfg.capacity}:${cfg.refillPerSec}`
  let limiter = limiterCache.get(cacheKey)
  if (!limiter) {
    // Upstash's tokenBucket wants integer refill rates. Our configs
    // are expressed as tokens-per-second (often a fraction like
    // 3/3600). Translate to a per-hour window — all current configs
    // produce clean integers (anon=3/hr, auth=10/hr).
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
      // the request and revisit if it becomes frequent.
      debugLog("rateLimit.upstashLimit", err)
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
  const xff = req.headers.get("x-forwarded-for")
  if (xff) {
    const first = xff.split(",")[0]?.trim()
    if (first) return first
  }
  const real = req.headers.get("x-real-ip")
  if (real) return real.trim()
  return "unknown"
}
