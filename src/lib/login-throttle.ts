/**
 * Brute-force protection for POST /api/auth/login — counts FAILURES, per account and per client address.
 *
 * WHY THIS IS NOT IN THE MIDDLEWARE ANY MORE. The middleware ran a limiter on `/api/auth/login` whose own
 * comment read "brute force protection", which was false in two measured ways:
 *
 *   1. It counted SUCCESSES. The middleware cannot see the outcome of a request, so every POST consumed
 *      quota — the 11th person to sign in inside one 60-second window was refused, on a single on-prem
 *      install where logging in is the thing the product is for. Only a FAILED attempt is evidence of
 *      guessing, and only the route knows which happened.
 *   2. It keyed the bucket on the session cookie, and a login request has none, so the key was the literal
 *      `session::/api/auth/login`. Every caller shared ONE bucket: one person's mistyping spent the whole
 *      company's quota, and an attacker could lock every user out of the install with ten wrong passwords.
 *
 * So the guard lives here, inside the route, and is keyed on identifiers that distinguish callers: the
 * normalized account (that is what an attacker guesses at) and the client address (that is what a sprayer
 * cannot change cheaply). The window is the same 60 seconds the rest of the app advertises in `Retry-After`.
 *
 * IN-MEMORY, SINGLE-INSTANCE, on purpose. `src/lib/redis.ts` has a distributed limiter that fails OPEN when
 * Redis is down, which for a brute-force guard means "no protection, silently" — and this app must keep
 * letting people log in when Redis is unavailable, so failing closed is not an option either. This install
 * runs one app instance per customer, which is the same ceiling `src/middleware.ts` documents for its own
 * counters. A multi-instance deployment would need a shared store; that is a deployment decision, recorded
 * rather than assumed.
 *
 * THE LOCKOUT TRADE-OFF, STATED. Exhausting an account's budget refuses the NEXT attempt for that account,
 * including one that would have succeeded. That is inherent to per-account limiting, it is bounded by the
 * 60-second window, and it is why a success clears the account's budget: an attacker must not be able to
 * hold a real user out for the rest of the window, and a success is proof the caller knows the password.
 */
import { RATE_LIMIT_LOGIN, RATE_LIMIT_LOGIN_PER_IP, RATE_LIMIT_WINDOW_MS } from './constants'

export interface LoginThrottleVerdict {
  limited: boolean
  /** The limit that was hit — reported in `X-RateLimit-Limit` so the header names the real cause. 0 when allowed. */
  limit: number
  /** Whole seconds until the bucket resets, for a truthful `Retry-After`. 0 when allowed. */
  retryAfterSeconds: number
}

interface Bucket {
  count: number
  resetAt: number
}

const FAILURES = new Map<string, Bucket>()

/** Same ceiling and rationale as the middleware's own sweep: it keeps an abused map bounded. */
const MAX_BUCKETS = 1000

/** Distinct prefixes so an account literally named like an address cannot collide with one. */
const ACCOUNT_PREFIX = 'acct:'
const IP_PREFIX = 'ip:'

function limitForKey(key: string): number {
  return key.startsWith(ACCOUNT_PREFIX) ? RATE_LIMIT_LOGIN : RATE_LIMIT_LOGIN_PER_IP
}

/** Returns the bucket only when it is still inside its window AND has reached its limit; null otherwise. */
function bucketOverLimit(key: string, now: number): Bucket | null {
  const bucket = FAILURES.get(key)
  if (!bucket || now > bucket.resetAt) return null
  return bucket.count >= limitForKey(key) ? bucket : null
}

function recordFailure(key: string, now: number): void {
  const bucket = FAILURES.get(key)
  if (!bucket || now > bucket.resetAt) {
    FAILURES.set(key, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS })
    if (FAILURES.size > MAX_BUCKETS) {
      for (const [k, b] of FAILURES) if (now > b.resetAt) FAILURES.delete(k)
    }
    return
  }
  bucket.count += 1
}

/**
 * Called BEFORE the lookup, so a locked-out account costs one Map read instead of a database round trip.
 *
 * The account axis is checked first because it is the tighter, more specific one: an attacker hammering a
 * single account should be stopped by the account rule even when the address rule would still let it through.
 */
export function checkLoginThrottle(
  account: string,
  ip: string,
  now: number = Date.now(),
): LoginThrottleVerdict {
  for (const key of [ACCOUNT_PREFIX + account, IP_PREFIX + ip]) {
    const bucket = bucketOverLimit(key, now)
    if (bucket) {
      return {
        limited: true,
        limit: limitForKey(key),
        // Never advertise 0 seconds: a client retrying immediately would fail again and read that as a
        // broken limit. At the exact window boundary the remaining time IS 0, so the floor of 1 matters.
        retryAfterSeconds: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)),
      }
    }
  }
  return { limited: false, limit: 0, retryAfterSeconds: 0 }
}

/**
 * Counted for EVERY failed verification — including an email that matches no user, which is the case an
 * attacker hitting many addresses produces, and the only case where the address axis is the sole signal.
 */
export function recordLoginFailure(account: string, ip: string, now: number = Date.now()): void {
  recordFailure(ACCOUNT_PREFIX + account, now)
  recordFailure(IP_PREFIX + ip, now)
}

/**
 * Clears the ACCOUNT budget only. The address budget deliberately survives a success: otherwise a caller
 * could spend the address quota guessing, log into their own account once, and start over.
 */
export function clearLoginFailures(account: string): void {
  FAILURES.delete(ACCOUNT_PREFIX + account)
}

/** Test-only: the counters are module state, so anything that counts attempts must start from zero. */
export function resetLoginThrottleForTests(): void {
  FAILURES.clear()
}

/** Test-only: makes the eviction sweep's effect observable, which it otherwise is not. */
export function countLoginThrottleBucketsForTests(): number {
  return FAILURES.size
}
