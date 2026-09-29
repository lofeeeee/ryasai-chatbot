/**
 * The brute-force guard for the sign-in route.
 *
 * WHY THESE ASSERTIONS ARE SHAPED THIS WAY. The defect this module fixes was not "the limit was too high" —
 * it was that the limit counted the WRONG THING (requests, including successes) against the WRONG KEY (a
 * session cookie that a login request cannot have). So the tests pin both axes separately, pin that a
 * success clears the account budget and NOT the address budget, and pin that checking does not itself
 * consume anything: a guard that decrements on inspection would turn a page load into an attack.
 */
import { describe, expect, test, beforeEach } from 'bun:test'
import {
  checkLoginThrottle,
  clearLoginFailures,
  countLoginThrottleBucketsForTests,
  recordLoginFailure,
  resetLoginThrottleForTests,
} from './login-throttle'
import { RATE_LIMIT_LOGIN, RATE_LIMIT_LOGIN_PER_IP, RATE_LIMIT_WINDOW_MS } from './constants'

const T0 = 1_700_000_000_000
const A = '203.0.113.1'
const B = '203.0.113.2'

beforeEach(() => {
  resetLoginThrottleForTests()
})

describe('login throttle — the ACCOUNT axis', () => {
  test('a fresh account is allowed, and an allowed verdict carries no limit numbers', () => {
    const verdict = checkLoginThrottle('a@x.com', A, T0)
    expect(verdict).toEqual({ limited: false, limit: 0, retryAfterSeconds: 0 })
  })

  test('CHECKING does not consume the budget — only a recorded failure does', () => {
    for (let i = 0; i < 25; i += 1) {
      expect(checkLoginThrottle('a@x.com', A, T0).limited).toBe(false)
    }
    recordLoginFailure('a@x.com', A, T0)
    expect(checkLoginThrottle('a@x.com', A, T0).limited).toBe(false)
  })

  test(`locks the account on the ${RATE_LIMIT_LOGIN}th failure, not before`, () => {
    for (let i = 1; i <= RATE_LIMIT_LOGIN; i += 1) {
      expect(checkLoginThrottle('a@x.com', A, T0).limited).toBe(false)
      recordLoginFailure('a@x.com', A, T0)
    }
    const after = checkLoginThrottle('a@x.com', A, T0)
    expect(after.limited).toBe(true)
    expect(after.limit).toBe(RATE_LIMIT_LOGIN)
  })

  test('a success clears the ACCOUNT budget', () => {
    for (let i = 0; i < RATE_LIMIT_LOGIN; i += 1) recordLoginFailure('a@x.com', A, T0)
    expect(checkLoginThrottle('a@x.com', A, T0).limited).toBe(true)
    clearLoginFailures('a@x.com')
    expect(checkLoginThrottle('a@x.com', A, T0).limited).toBe(false)
  })

  test('clearing one account does not clear another', () => {
    for (let i = 0; i < RATE_LIMIT_LOGIN; i += 1) recordLoginFailure('a@x.com', A, T0)
    clearLoginFailures('someone@else.com')
    expect(checkLoginThrottle('a@x.com', A, T0).limited).toBe(true)
  })
})

describe('login throttle — the ADDRESS axis', () => {
  test(`caps spraying across accounts: the ${RATE_LIMIT_LOGIN_PER_IP}th failure from one address is refused`, () => {
    // Each attempt uses a DIFFERENT account, so no account budget is reached; only the address axis can see it.
    for (let i = 0; i < RATE_LIMIT_LOGIN_PER_IP; i += 1) recordLoginFailure(`u${i}@x.com`, A, T0)
    const verdict = checkLoginThrottle('fresh@x.com', A, T0)
    expect(verdict.limited).toBe(true)
    expect(verdict.limit).toBe(RATE_LIMIT_LOGIN_PER_IP)
  })

  test('a DIFFERENT address is unaffected', () => {
    for (let i = 0; i < RATE_LIMIT_LOGIN_PER_IP; i += 1) recordLoginFailure(`u${i}@x.com`, A, T0)
    expect(checkLoginThrottle('fresh@x.com', B, T0).limited).toBe(false)
  })

  test('a success does NOT clear the address budget', () => {
    // The documented trade-off: otherwise a caller could spend the address quota guessing, sign into their
    // own account once, and start over, and the address axis would count nothing.
    for (let i = 0; i < RATE_LIMIT_LOGIN_PER_IP; i += 1) recordLoginFailure(`u${i}@x.com`, A, T0)
    clearLoginFailures('fresh@x.com')
    expect(checkLoginThrottle('fresh@x.com', A, T0).limited).toBe(true)
  })

  test('an UNKNOWN address gets a shared bucket rather than none', () => {
    for (let i = 0; i < RATE_LIMIT_LOGIN_PER_IP; i += 1) recordLoginFailure(`u${i}@x.com`, 'unknown', T0)
    expect(checkLoginThrottle('fresh@x.com', 'unknown', T0).limited).toBe(true)
  })
})

describe('login throttle — the window', () => {
  test('the account unlocks once the window elapses', () => {
    for (let i = 0; i < RATE_LIMIT_LOGIN; i += 1) recordLoginFailure('a@x.com', A, T0)
    expect(checkLoginThrottle('a@x.com', A, T0 + RATE_LIMIT_WINDOW_MS + 1).limited).toBe(false)
  })

  test('Retry-After counts down and never advertises 0 seconds', () => {
    for (let i = 0; i < RATE_LIMIT_LOGIN; i += 1) recordLoginFailure('a@x.com', A, T0)
    const atStart = checkLoginThrottle('a@x.com', A, T0)
    const later = checkLoginThrottle('a@x.com', A, T0 + 30_000)
    expect(atStart.retryAfterSeconds).toBeGreaterThan(30)
    expect(atStart.retryAfterSeconds).toBeLessThanOrEqual(60)
    expect(later.retryAfterSeconds).toBeGreaterThan(0)
    expect(later.retryAfterSeconds).toBeLessThan(atStart.retryAfterSeconds)
    // Exactly at the boundary the bucket has NOT expired (`now > resetAt` is the reset test), so the
    // remaining time is 0 seconds and the floor must turn that into 1 rather than advertise an immediate
    // retry that would fail again.
    const boundary = checkLoginThrottle('a@x.com', A, T0 + RATE_LIMIT_WINDOW_MS)
    expect(boundary.limited).toBe(true)
    expect(boundary.retryAfterSeconds).toBe(1)
  })
})

describe('login throttle — bucket growth', () => {
  test('the sweep drops EXPIRED buckets once the map passes its ceiling', () => {
    for (let i = 0; i < 1005; i += 1) recordLoginFailure(`old${i}@x.com`, A, T0)
    const before = countLoginThrottleBucketsForTests()
    expect(before).toBeGreaterThan(1000)
    // Two windows later every bucket is stale; recording one more must trigger the sweep.
    recordLoginFailure('new@x.com', B, T0 + RATE_LIMIT_WINDOW_MS * 2)
    const after = countLoginThrottleBucketsForTests()
    expect(after).toBeLessThan(before)
    expect(after).toBeLessThan(10)
  })

  test('the sweep does not drop a LIVE bucket, so the limit still holds afterwards', () => {
    for (let i = 0; i < RATE_LIMIT_LOGIN; i += 1) recordLoginFailure('live@x.com', A, T0)
    for (let i = 0; i < 1005; i += 1) recordLoginFailure(`f${i}@x.com`, B, T0)
    recordLoginFailure('new@x.com', '203.0.113.3', T0) // sweep runs; nothing is expired
    expect(checkLoginThrottle('live@x.com', A, T0).limited).toBe(true)
  })
})
