/**
 * Distributed rate limiting: one shared counter in Redis, this process's own Map as the fallback.
 *
 * WHY THIS EXISTS. `src/middleware.ts` counts requests in a module-scope `Map`, so each instance
 * keeps an INDEPENDENT counter: N instances behind one load balancer hand out N x the configured
 * limit. The expensive LLM routes are the worst place for that ceiling to be per-instance — every
 * request is an LLM call paid for out of the customer's own provider key. `rateLimit` in
 * `@/lib/redis` already implements the shared counter (INCR + EXPIRE, ~1 round-trip); this module
 * is the seam that turns its "Redis is down" answer (null) back into a bounded verdict instead of
 * an unbounded one.
 *
 * WHY FAIL OPEN TO MEMORY, NOT CLOSED. A limiter that refuses every request when Redis is
 * unreachable would take the whole app down with the cache — the exact failure the Redis helper
 * already avoids by returning null. Falling back to the per-instance Map restores precisely the
 * behaviour the install had before this module existed: still bounded, just bounded per instance.
 */

import { RATE_LIMIT_WINDOW_MS } from '@/lib/constants'

export interface RateLimitDecision {
  allowed: boolean
  remaining: number
  /**
   * Where the verdict came from. `checkRateLimit` only ever answers `'redis'` or `'memory'`;
   * `'none'` exists so a caller that applied NO limiter at all can express that in the same type —
   * `src/middleware.ts` keeps its own Map path for the non-LLM routes and does not go through here.
   */
  source: 'redis' | 'memory' | 'none'
}

/**
 * Ceiling on the fallback map. Distinct keys are attacker-controlled text (a fresh
 * `X-Forwarded-For` mints a fresh key), so an unbounded map is a memory-exhaustion vector aimed
 * at the process that serves the most expensive routes. Same shape as the middleware's own
 * 1000-entry sweep, but exported so tests can drive past it deterministically.
 */
export const MEMORY_BUCKET_MAX = 5000

interface MemoryBucket {
  count: number
  resetAt: number
}

const MEMORY_BUCKETS = new Map<string, MemoryBucket>()

type RedisModule = typeof import('@/lib/redis')

/**
 * WHY `@/lib/redis` IS RESOLVED LAZILY instead of imported at the top of the file.
 *
 * That module opens two ioredis clients and a BullMQ queue at module scope, and ioredis speaks
 * TCP — a Node-only capability. `src/middleware.ts` imports this file and runs on the Edge runtime,
 * where those sockets do not exist; a static import would evaluate the connection setup during the
 * middleware's own module evaluation, i.e. on every cold start, and would drag ioredis into the
 * middleware bundle. Resolving on first use keeps that cost out of the import path, and a module
 * that cannot load in this runtime is remembered so a burst of requests does not re-pay the failed
 * load on every call. `bun test` files that mock `@/lib/redis` register the mock before the first
 * call, so the seam stays mockable either way.
 */
let redisModule: RedisModule | null = null
let redisUnavailable = false

async function resolveRedis(): Promise<RedisModule | null> {
  if (redisModule) return redisModule
  if (redisUnavailable) return null
  try {
    redisModule = await import('@/lib/redis')
    return redisModule
  } catch {
    // Module resolution is not transient: what failed to load here fails again. Record it once.
    redisUnavailable = true
    return null
  }
}

/**
 * The verdict for one key over one minute.
 *
 * Redis is asked first; its answer is propagated verbatim (allowed AND remaining) because it is
 * the only participant that knows what the OTHER instances already spent — recomputing it here
 * would make the shared counter decorative. When Redis answers null (unreachable) the per-instance
 * Map below takes over, keyed on the same `key` with the same 60-second window the 429's
 * `Retry-After: 60` advertises.
 */
export async function checkRateLimit(args: {
  key: string
  maxPerMinute: number
  now?: number
}): Promise<RateLimitDecision> {
  const { key, maxPerMinute } = args
  const redis = await resolveRedis()
  if (redis) {
    // `rateLimit` already swallows its own Redis errors and answers null; the extra catch is for
    // anything that escapes it, so an outage degrades to memory instead of throwing to the gate.
    const verdict = await redis.rateLimit(key, maxPerMinute).catch(() => null)
    if (verdict) return { allowed: verdict.allowed, remaining: verdict.remaining, source: 'redis' }
  }
  return memoryVerdict(key, maxPerMinute, args.now ?? Date.now())
}

/**
 * The per-instance fallback — deliberately the same shape as the middleware's Map limiter, so an
 * outage degrades to behaviour that is already understood rather than to a new one.
 *
 * The sweep is a memory optimisation over EXPIRED buckets only, exactly as in the middleware:
 * buckets that are still live are never evicted, because evicting a live bucket on map pressure
 * would let a caller mint fresh quota for itself just by inserting keys. A burst of distinct LIVE
 * keys can therefore still exceed MEMORY_BUCKET_MAX within one window; that is the same accepted
 * trade-off the middleware records, and the Redis arm is the one that holds under a real flood.
 */
function memoryVerdict(key: string, maxPerMinute: number, now: number): RateLimitDecision {
  const bucket = MEMORY_BUCKETS.get(key)
  if (!bucket || now > bucket.resetAt) {
    MEMORY_BUCKETS.set(key, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS })
    if (MEMORY_BUCKETS.size > MEMORY_BUCKET_MAX) {
      for (const [k, b] of MEMORY_BUCKETS) if (now > b.resetAt) MEMORY_BUCKETS.delete(k)
    }
    return { allowed: true, remaining: Math.max(0, maxPerMinute - 1), source: 'memory' }
  }
  bucket.count += 1
  if (bucket.count <= maxPerMinute) {
    return { allowed: true, remaining: Math.max(0, maxPerMinute - bucket.count), source: 'memory' }
  }
  return { allowed: false, remaining: 0, source: 'memory' }
}

/** Clears the fallback map and the cached Redis resolution. Test isolation only. */
export function resetRateLimitStateForTests(): void {
  MEMORY_BUCKETS.clear()
  redisModule = null
  redisUnavailable = false
}

/**
 * Size of the fallback map. Exported because the size cap is the property under test: the sweep
 * only becomes observable once the map actually passes the cap, which no small test run reaches
 * by accident.
 */
export function getMemoryBucketCountForTests(): number {
  return MEMORY_BUCKETS.size
}
