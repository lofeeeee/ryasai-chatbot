// Deterministic backoff whether this file runs alone (default 500 ms) or under the suite runner (which injects 25).
// It must be set BEFORE the module that reads it is imported, because the constant is evaluated at load.
process.env.LLM_RETRY_BACKOFF_BASE_MS ||= '1'

import { describe, expect, test } from 'bun:test'
import { fetchWithRetry, isTimeoutError } from './llm-client-utils'
import { LLM_MAX_RETRIES } from './constants'

// The retry ladder decides how long a slow provider can hold a user. It used to retry EVERY failure, so a
// TIMEOUT — which means the request already sat open for the full budget — spent that budget again, up to four
// times: MEASURED 30-60 s of p95 on the latency harness, and 3 of 12 tool-selection calls returned `null` and fell
// back to the heuristic router. These tests drive the REAL function against a stubbed fetch, so the ladder's
// behaviour is observed rather than described.

const originalFetch = globalThis.fetch
const withFetch = async (impl: (url: unknown, init?: RequestInit) => Promise<Response>, run: () => Promise<void>) => {
  globalThis.fetch = impl as unknown as typeof fetch
  try { await run() } finally { globalThis.fetch = originalFetch }
}
const timeoutError = () => Object.assign(new Error('The operation timed out.'), { name: 'TimeoutError' })
const ok = () => new Response('{}', { status: 200 })

describe('isTimeoutError', () => {
  test('matches the shapes each runtime produces', () => {
    expect(isTimeoutError(timeoutError())).toBe(true)
    // Node's undici wraps the cause; the outer name is AbortError but the CAUSE carries the truth.
    expect(isTimeoutError(Object.assign(new Error('aborted'), { name: 'AbortError', cause: { name: 'TimeoutError' } }))).toBe(true)
    expect(isTimeoutError(new Error('fetch failed: ETIMEDOUT'))).toBe(true)
  })
  test('a plain AbortError is a CANCELLATION, not a timeout', () => {
    // MEASURED on Bun: a manual abort throws AbortError; AbortSignal.timeout throws TimeoutError. Calling both a
    // "timeout" blamed the provider for a caller's own cancellation.
    expect(isTimeoutError(Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' }))).toBe(false)
    // …even when its message happens to contain the word, because the NAME is the contract.
    expect(isTimeoutError(Object.assign(new Error('aborted due to timeout handler'), { name: 'AbortError' }))).toBe(false)
  })
  test('does NOT match a connection failure, which is fast and worth retrying', () => {
    expect(isTimeoutError(Object.assign(new Error('Unable to connect. Is the computer able to access the url?'), { name: 'TypeError' }))).toBe(false)
    expect(isTimeoutError(new Error('fetch failed'))).toBe(false)
    expect(isTimeoutError(new Error('LLM error (HTTP 503).'))).toBe(false)
  })
})

describe('fetchWithRetry', () => {
  test('a TIMEOUT is attempted ONCE, so a slow provider cannot multiply the wait', async () => {
    let calls = 0
    await withFetch(async () => { calls += 1; throw timeoutError() }, async () => {
      await expect(fetchWithRetry('http://x', {})).rejects.toThrow()
    })
    // One attempt, not 1 + LLM_MAX_RETRIES. Without this the worst case is 4x the timeout budget.
    expect(calls).toBe(1)
    expect(LLM_MAX_RETRIES).toBeGreaterThan(0) // the ladder still exists for the other failures
  })

  test('a CONNECTION error still uses the full ladder', async () => {
    let calls = 0
    await withFetch(async () => { calls += 1; throw new TypeError('Unable to connect. Is the computer able to access the url?') }, async () => {
      await expect(fetchWithRetry('http://x', {})).rejects.toThrow()
    })
    expect(calls).toBe(LLM_MAX_RETRIES + 1)
  })

  test('a 5xx still uses the full ladder and succeeds when the provider recovers', async () => {
    let calls = 0
    await withFetch(async () => {
      calls += 1
      return calls < 2 ? new Response('boom', { status: 503 }) : ok()
    }, async () => {
      const res = await fetchWithRetry('http://x', {})
      expect(res.status).toBe(200)
    })
    expect(calls).toBe(2)
  })

  test('a CANCELLED request is attempted once: nobody is waiting for the answer', async () => {
    let calls = 0
    await withFetch(async () => { calls += 1; throw Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' }) }, async () => {
      await expect(fetchWithRetry('http://x', {})).rejects.toThrow()
    })
    expect(calls).toBe(1)
  })

  test('a persistent 5xx is returned to the caller after the ladder, with each abandoned body released', async () => {
    // MEASURED behaviour, not assumed: the final 5xx RESPONSE is returned (the caller decides what a 503 means,
    // and `classifyProviderFailure` lives above this function) and the bodies of the ABANDONED attempts are
    // cancelled — 4 attempts, 3 cancellations. An unread body holds its socket until the collector reaches it, so
    // without the cancels a single request could strand three upstream connections.
    const real = globalThis.fetch
    let attempts = 0
    let cancelled = 0
    globalThis.fetch = (async () => {
      attempts += 1
      return { status: 503, body: { cancel: async () => { cancelled += 1 } } }
    }) as never
    try {
      const res = await fetchWithRetry('http://x', {})
      expect(res.status).toBe(503)
      expect(attempts).toBe(LLM_MAX_RETRIES + 1)
      expect(cancelled, 'every abandoned attempt must release its body').toBe(LLM_MAX_RETRIES)
    } finally { globalThis.fetch = real }
  })

  test('a body that refuses to be released does not change the outcome', async () => {
    // Best-effort by design. The `catch` around the cancel is what keeps a draining failure from being read as a
    // provider failure: MEASURED, a version that rethrew inside that catch still attempted the same number of times
    // and still returned the same 503, so the outcome is what has to be asserted, not an attempt count.
    const real = globalThis.fetch
    let attempts = 0
    globalThis.fetch = (async () => {
      attempts += 1
      return { status: 503, body: { cancel: async () => { throw new Error('already gone') } } }
    }) as never
    try {
      const res = await fetchWithRetry('http://x', {})
      expect(res.status).toBe(503)
      expect(attempts).toBe(LLM_MAX_RETRIES + 1)
    } finally { globalThis.fetch = real }
  })

  test('a caller-supplied signal is NOT replaced by the timeout signal', async () => {
    // The two streaming paths pass their own 120 s signal; overriding it with the 30 s default would cut a long
    // legitimate answer short.
    const mine = new AbortController()
    let seen: AbortSignal | undefined
    await withFetch(async (_u: unknown, init?: RequestInit) => { seen = init?.signal as AbortSignal; return ok() }, async () => {
      await fetchWithRetry('http://x', { signal: mine.signal })
    })
    expect(seen).toBe(mine.signal)
  })
})
