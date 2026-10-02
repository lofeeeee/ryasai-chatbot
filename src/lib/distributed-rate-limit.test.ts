/**
 * Distributed rate limiter — the Redis-first / memory-fallback seam the middleware's LLM routes go
 * through.
 *
 * WHY THIS FILE EXISTS. The middleware's Map counts per instance, so N instances hand out N x the
 * limit; the shared counter is `rateLimit` in `@/lib/redis`. What this file pins is the CONTRACT
 * BETWEEN THEM — the part neither side can test alone:
 *
 *   - the Redis verdict is propagated verbatim (it is the only participant that knows what the
 *     other instances already spent), and
 *   - a Redis outage does NOT open the floodgates: the memory bucket still enforces maxPerMinute
 *     on this instance, which is exactly the pre-existing behaviour an outage must degrade to.
 *
 * `@/lib/redis` is mocked here rather than a real socket being dialled, because the property under
 * test is the FALLBACK, not the INCR — and Bun's `mock.module` runs before this file's first call
 * to `checkRateLimit`, so the lazy `import('@/lib/redis')` inside it resolves to the mock.
 */
import { describe, expect, test, mock, beforeEach } from 'bun:test'

const mockRateLimit = mock<
  (key: string, maxPerMinute: number) => Promise<{ allowed: boolean; remaining: number } | null>
>(async () => null)

mock.module('@/lib/redis', () => ({
  rateLimit: mockRateLimit,
}))

// Imported AFTER mock.module so the lazy resolution inside checkRateLimit sees the mock.
import {
  checkRateLimit,
  resetRateLimitStateForTests,
  getMemoryBucketCountForTests,
  MEMORY_BUCKET_MAX,
} from './distributed-rate-limit'

beforeEach(() => {
  mockRateLimit.mockImplementation(async () => null)
  resetRateLimitStateForTests()
})

describe('checkRateLimit — Redis path', () => {
  test("source is 'redis', the verdict and remaining are propagated verbatim", async () => {
    // The Redis helper is the only participant that knows what the OTHER instances spent, so its
    // numbers must cross this seam unchanged: recomputing remaining here would make the shared
    // counter decorative, and flipping `allowed` would either break an instance-local decision or
    // override the shared one.
    mockRateLimit.mockImplementation(async () => ({ allowed: true, remaining: 17 }))
    const r = await checkRateLimit({ key: 'ip:1.2.3.4:/api/chat/sessions', maxPerMinute: 30 })
    expect(r).toEqual({ allowed: true, remaining: 17, source: 'redis' })
  })

  test('a Redis DENIAL is denied here too, with remaining 0', async () => {
    // If this seam flipped the verdict back to allowed, the shared counter would be advisory only.
    mockRateLimit.mockImplementation(async () => ({ allowed: false, remaining: 0 }))
    const r = await checkRateLimit({ key: 'ip:5.6.7.8:/api/v1/agent/run', maxPerMinute: 20 })
    expect(r).toEqual({ allowed: false, remaining: 0, source: 'redis' })
  })

  test("a DENIED Redis verdict does not touch the memory bucket (source stays 'redis')", async () => {
    // A denied Redis verdict consumed quota on the shared counter. Writing it ALSO into the local
    // map would double-count the same request the next time Redis is down.
    mockRateLimit.mockImplementation(async () => ({ allowed: false, remaining: 0 }))
    await checkRateLimit({ key: 'k-redis-denied', maxPerMinute: 5 })
    expect(getMemoryBucketCountForTests()).toBe(0)
  })
})

describe('checkRateLimit — Redis down (null), memory fallback', () => {
  test("falls back to memory, source 'memory', and the bucket enforces maxPerMinute", async () => {
    // THE core property: an outage must degrade to the OLD (bounded) behaviour, not to unlimited.
    // A limiter that allowed everything when Redis is down would make taking the cache down a
    // cheap way to take the cost ceiling off the LLM routes. Same key throughout, because a
    // different key would mint a fresh bucket and prove nothing about the limit.
    const key = 'ip:198.51.100.7:/api/chat/sessions'
    const max = 3
    const decisions: boolean[] = []
    for (let i = 0; i < max + 2; i += 1) {
      const r = await checkRateLimit({ key, maxPerMinute: max })
      expect(r.source).toBe('memory')
      decisions.push(r.allowed)
    }
    // First `max` allowed, then refused — the memory bucket still bounds this instance.
    expect(decisions.slice(0, max).every(Boolean)).toBe(true)
    expect(decisions.slice(max).every((a) => !a)).toBe(true)
    expect((await checkRateLimit({ key, maxPerMinute: max })).remaining).toBe(0)
  })

  test('memory fallback counts down remaining as the bucket fills', async () => {
    // Pinning the arithmetic so a future edit cannot quietly change the advertised allowance:
    // max 3 → first call sees 2 left, second 1, third 0, fourth denied at 0.
    const key = 'remaining-drain'
    expect((await checkRateLimit({ key, maxPerMinute: 3 })).remaining).toBe(2)
    expect((await checkRateLimit({ key, maxPerMinute: 3 })).remaining).toBe(1)
    expect((await checkRateLimit({ key, maxPerMinute: 3 })).remaining).toBe(0)
    expect((await checkRateLimit({ key, maxPerMinute: 3 })).allowed).toBe(false)
  })
})

describe('checkRateLimit — memory bucket expiry (the `now` seam)', () => {
  test('a bucket set at t=0 is gone at t=61000 and the count restarts', async () => {
    // The 429 advertises Retry-After: 60, so the window must actually be 60s: a client that
    // waits the advertised minute and retries must get a FRESH bucket, while a bucket that never
    // expired would refuse it forever. 61000 (not 60000) so the boundary is unambiguous.
    const key = 'expiry-seam'
    expect((await checkRateLimit({ key, maxPerMinute: 1, now: 0 })).allowed).toBe(true)
    expect((await checkRateLimit({ key, maxPerMinute: 1, now: 1000 })).allowed).toBe(false)
    const after = await checkRateLimit({ key, maxPerMinute: 1, now: 61_000 })
    expect(after.allowed).toBe(true)
    expect(after.remaining).toBe(0)
    expect(after.source).toBe('memory')
  })

  test('at exactly t=60000 the old bucket is still authoritative (no early reset)', async () => {
    // `now > resetAt` is strict, so the 60000th millisecond still belongs to the FIRST window.
    // Pinning the boundary keeps a future ">= " change from silently shrinking the window by a
    // tick and granting a free request to every key exactly at the boundary.
    const key = 'expiry-boundary'
    await checkRateLimit({ key, maxPerMinute: 1, now: 0 })
    expect((await checkRateLimit({ key, maxPerMinute: 1, now: 60_000 })).allowed).toBe(false)
    expect((await checkRateLimit({ key, maxPerMinute: 1, now: 60_001 })).allowed).toBe(true)
    expect(getMemoryBucketCountForTests()).toBe(1)
  })

  test('an expired bucket is dropped, not just ignored (the map does not retain stale keys)', async () => {
    // The sweep is triggered on new-bucket insertions; the read path must not merely ignore a
    // stale entry but REPLACE it, so the map cannot fill with dead buckets for keys that stopped
    // calling. Asserted via the size getter: the second call must not have added a second entry.
    const key = 'expiry-replace'
    await checkRateLimit({ key, maxPerMinute: 1, now: 0 })
    expect((await checkRateLimit({ key, maxPerMinute: 1, now: 61_000 })).allowed).toBe(true)
    expect(getMemoryBucketCountForTests()).toBe(1)
  })
})

describe('checkRateLimit — the fallback map is size-bounded', () => {
  test(`inserting MEMORY_BUCKET_MAX + 100 distinct stale keys keeps the map bounded`, async () => {
    // The keys are attacker-controlled (a fresh forged X-Forwarded-For mints a fresh key), so an
    // unbounded map is a memory-exhaustion vector. Every key is given a STALE resetAt on purpose:
    // the sweep deletes expired buckets only, so stale keys are exactly the ones it can reclaim.
    // All insertions use one fixed `now`, and each key's own window opens at that same instant —
    // a key minted at `now` has resetAt = now + 60000, which is NOT stale relative to `now`, so
    // the FIRST sweep would find nothing to delete; asserting `<= MEMORY_BUCKET_MAX + 100` would
    // then be vacuous. The assertion is the one that makes the cap real: after the run the map
    // must hold at most MEMORY_BUCKET_MAX entries for a fresh `now` (where every bucket is stale).
    for (let i = 0; i < MEMORY_BUCKET_MAX + 100; i += 1) {
      await checkRateLimit({ key: `flood-${i}`, maxPerMinute: 1, now: 0 })
    }
    // All buckets were minted at t=0. At t=61_000 every one of them is stale, so the next call
    // both mints its own fresh bucket and triggers the sweep that clears the stale 5100.
    await checkRateLimit({ key: 'trigger-sweep', maxPerMinute: 1, now: 61_000 })
    // The sweep removed the 5100 stale entries and the trigger's own bucket is 1 live entry.
    expect(getMemoryBucketCountForTests()).toBeLessThanOrEqual(MEMORY_BUCKET_MAX)
    expect(getMemoryBucketCountForTests()).toBe(1)
    expect(await checkRateLimit({ key: 'flood-0', maxPerMinute: 1, now: 61_000 })).toEqual({
      allowed: true,
      remaining: 0,
      source: 'memory',
    })
  })
})

describe('checkRateLimit — different keys do not share a bucket', () => {
  test('consecutive failures with different keys are independent (neither is denied by the other)', async () => {
    // If the fallback keyed on nothing but "Redis is down" — one global bucket per outage — a
    // single heavy caller would lock every OTHER caller out of the expensive routes for the whole
    // outage, which is a denial-of-service one user can cause by hitting F5. Each key keeps its
    // own bucket, so the worst case is the pre-existing per-instance ceiling, never a shared one.
    const max = 2
    for (let i = 0; i < max + 1; i += 1) {
      const r = await checkRateLimit({ key: 'caller-A', maxPerMinute: max })
      expect(r.allowed).toBe(i < max)
    }
    // A different key is unaffected by caller-A's exhausted bucket...
    expect((await checkRateLimit({ key: 'caller-B', maxPerMinute: max })).allowed).toBe(true)
    expect((await checkRateLimit({ key: 'caller-B', maxPerMinute: max })).allowed).toBe(true)
    // ...and exhausting B does not retroactively deny A any further than A's own bucket already
    // did (A stays denied, B is now denied too — each by its OWN count).
    expect((await checkRateLimit({ key: 'caller-A', maxPerMinute: max })).allowed).toBe(false)
    expect((await checkRateLimit({ key: 'caller-B', maxPerMinute: max })).allowed).toBe(false)
    // Two buckets, one per key — not one shared.
    expect(getMemoryBucketCountForTests()).toBe(2)
  })
})
