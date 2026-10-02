import { beforeEach, describe, expect, mock, test } from 'bun:test'

// --- Mock: keep the check off a real Prisma client; capture every query ---
interface AggregateArgs {
  where?: { organizationId?: string; createdAt?: { gte?: Date } }
  _sum?: Record<string, boolean>
  _count?: boolean
}
/** Prisma returns null sums when no rows match, not 0. */
interface AggregateResult {
  _sum: { promptTokens: number | null; completionTokens: number | null }
  _count: number
}
const aggregateMock = mock(async (_args?: AggregateArgs): Promise<AggregateResult> => ({
  _sum: { promptTokens: 0, completionTokens: 0 },
  _count: 0,
}))
mock.module('@/lib/db', () => ({
  db: {
    llmUsageLog: { aggregate: aggregateMock },
  },
}))

import {
  ORG_BUDGET_CACHE_TTL_MS,
  checkOrgBudget,
  clearOrgBudgetCache,
  getOrgBudgetConfig,
  orgBudgetExceededMessage,
} from './org-budget'

/** Most tests pass an explicit config so env state cannot leak in. */
const TOKENS_ONLY = { tokens: 1000, requests: 0 }
const REQUESTS_ONLY = { tokens: 0, requests: 50 }
const BOTH = { tokens: 1000, requests: 50 }

function setUsage(promptTokens: number, completionTokens: number, count: number) {
  aggregateMock.mockImplementation(async () => ({
    _sum: { promptTokens, completionTokens },
    _count: count,
  }))
}

beforeEach(() => {
  clearOrgBudgetCache()
  aggregateMock.mockReset()
  aggregateMock.mockImplementation(async () => ({
    _sum: { promptTokens: 0, completionTokens: 0 },
    _count: 0,
  }))
  delete process.env.ORG_DAILY_TOKEN_BUDGET
  delete process.env.ORG_DAILY_REQUEST_BUDGET
})

describe('checkOrgBudget — the unlimited hot path', () => {
  // FIRST and most important: an unconfigured install must not pay a DB round
  // trip per chat turn for a check that can only ever answer "no limit".
  test('unlimited config performs NO db call at all', async () => {
    const decision = await checkOrgBudget('org1')
    expect(aggregateMock).not.toHaveBeenCalled()
    expect(decision).toEqual({
      limited: false,
      tokensUsed: 0,
      requestsUsed: 0,
      tokensLimit: 0,
      requestsLimit: 0,
    })

    // Same guarantee for an explicitly-unlimited config object.
    await checkOrgBudget('org1', { tokens: 0, requests: 0 })
    expect(aggregateMock).not.toHaveBeenCalled()
  })

  test('one finite limit is enough to trigger the query', async () => {
    await checkOrgBudget('org1', TOKENS_ONLY)
    expect(aggregateMock).toHaveBeenCalledTimes(1)
  })
})

describe('checkOrgBudget — the aggregate query', () => {
  test('scopes to the org and to the start of today UTC, summing prompt+completion', async () => {
    const before = new Date()
    await checkOrgBudget('org-abc', BOTH)
    expect(aggregateMock).toHaveBeenCalledTimes(1)
    const call = aggregateMock.mock.calls[0]?.[0]
    expect(call?.where?.organizationId).toBe('org-abc')
    expect(call?._sum?.promptTokens).toBe(true)
    expect(call?._sum?.completionTokens).toBe(true)
    expect(call?._count).toBe(true)
    const gte = call?.where?.createdAt?.gte
    expect(gte).toBeInstanceOf(Date)
    const gteMs = (gte as Date).getTime()
    // Exactly a UTC midnight: divisible by one day, and within the last 24h.
    expect(gteMs % 86_400_000).toBe(0)
    expect(before.getTime() - gteMs).toBeGreaterThanOrEqual(0)
    expect(before.getTime() - gteMs).toBeLessThanOrEqual(86_400_000)
  })

  test('null sums (no rows today) count as zero, not NaN', async () => {
    aggregateMock.mockImplementation(async () => ({
      _sum: { promptTokens: null, completionTokens: null },
      _count: 0,
    }))
    const decision = await checkOrgBudget('org1', BOTH)
    expect(decision.limited).toBe(false)
    expect(decision.tokensUsed).toBe(0)
    expect(decision.requestsUsed).toBe(0)
  })
})

describe('checkOrgBudget — limit decisions', () => {
  test('token limit exceeded → limited with reason "tokens"', async () => {
    setUsage(700, 500, 3)
    const decision = await checkOrgBudget('org1', TOKENS_ONLY)
    expect(decision.limited).toBe(true)
    expect(decision.reason).toBe('tokens')
    expect(decision.tokensUsed).toBe(1200)
    expect(decision.tokensLimit).toBe(1000)
    expect(decision.requestsLimit).toBe(0)
    expect(decision.requestsUsed).toBe(3)
  })

  test('usage exactly AT the token cap is already limited (>=, not >)', async () => {
    setUsage(600, 400, 1)
    const decision = await checkOrgBudget('org1', TOKENS_ONLY)
    expect(decision.limited).toBe(true)
    expect(decision.reason).toBe('tokens')
  })

  test('request limit exceeded → limited with reason "requests"', async () => {
    setUsage(100, 50, 50)
    const decision = await checkOrgBudget('org1', REQUESTS_ONLY)
    expect(decision.limited).toBe(true)
    expect(decision.reason).toBe('requests')
    expect(decision.requestsUsed).toBe(50)
    expect(decision.requestsLimit).toBe(50)
    expect(decision.tokensLimit).toBe(0)
  })

  test('both limits exceeded → reason "tokens" wins', async () => {
    setUsage(2000, 1000, 99)
    const decision = await checkOrgBudget('org1', BOTH)
    expect(decision.limited).toBe(true)
    expect(decision.reason).toBe('tokens')
  })

  test('under both limits → not limited, usage reported', async () => {
    setUsage(300, 200, 7)
    const decision = await checkOrgBudget('org1', BOTH)
    expect(decision.limited).toBe(false)
    expect(decision.reason).toBeUndefined()
    expect(decision.tokensUsed).toBe(500)
    expect(decision.requestsUsed).toBe(7)
  })

  test('db failure propagates instead of reporting a fabricated "within budget"', async () => {
    aggregateMock.mockImplementation(async () => {
      throw new Error('db down')
    })
    await expect(checkOrgBudget('org1', TOKENS_ONLY)).rejects.toThrow('db down')
  })
})

describe('checkOrgBudget — in-process cache', () => {
  test('two calls within the TTL issue ONE db call', async () => {
    setUsage(100, 100, 1)
    const first = await checkOrgBudget('org1', BOTH)
    const second = await checkOrgBudget('org1', BOTH)
    expect(aggregateMock).toHaveBeenCalledTimes(1)
    expect(second).toEqual(first)

    // Clearing the cache makes the next call re-query — proves the single call
    // above was served from the cache, not from a stuck mock.
    clearOrgBudgetCache()
    await checkOrgBudget('org1', BOTH)
    expect(aggregateMock).toHaveBeenCalledTimes(2)
  })

  test('the cache is per-org: two orgs issue two calls', async () => {
    await checkOrgBudget('org1', BOTH)
    await checkOrgBudget('org2', BOTH)
    expect(aggregateMock).toHaveBeenCalledTimes(2)
    const org1Call = aggregateMock.mock.calls[0]?.[0]
    const org2Call = aggregateMock.mock.calls[1]?.[0]
    expect(org1Call?.where?.organizationId).toBe('org1')
    expect(org2Call?.where?.organizationId).toBe('org2')
  })

  test('different limits are a cache miss, not a hit', async () => {
    setUsage(100, 100, 1)
    const under = await checkOrgBudget('org1', TOKENS_ONLY)
    expect(under.limited).toBe(false)
    const tighter = await checkOrgBudget('org1', { tokens: 150, requests: 0 })
    expect(aggregateMock).toHaveBeenCalledTimes(2)
    expect(tighter.limited).toBe(true)
    expect(tighter.reason).toBe('tokens')
  })

  test('the TTL is short (5 s), matching a burst-within-one-turn scope', () => {
    expect(ORG_BUDGET_CACHE_TTL_MS).toBe(5_000)
  })
})

describe('getOrgBudgetConfig', () => {
  test('unset env → both limits 0 (unlimited), the safe default', () => {
    expect(getOrgBudgetConfig({})).toEqual({ tokens: 0, requests: 0 })
  })

  test('positive values are read from env', () => {
    expect(getOrgBudgetConfig({ ORG_DAILY_TOKEN_BUDGET: '500000' })).toEqual({
      tokens: 500000,
      requests: 0,
    })
    expect(getOrgBudgetConfig({ ORG_DAILY_REQUEST_BUDGET: '120' })).toEqual({
      tokens: 0,
      requests: 120,
    })
    expect(
      getOrgBudgetConfig({ ORG_DAILY_TOKEN_BUDGET: '500000', ORG_DAILY_REQUEST_BUDGET: '120' }),
    ).toEqual({ tokens: 500000, requests: 120 })
  })

  test('invalid values mean unlimited, not zero-limit-everything', () => {
    for (const bad of ['abc', '-5', '', '0', 'Infinity']) {
      expect(getOrgBudgetConfig({ ORG_DAILY_TOKEN_BUDGET: bad }).tokens).toBe(0)
      expect(getOrgBudgetConfig({ ORG_DAILY_REQUEST_BUDGET: bad }).requests).toBe(0)
    }
  })

  test('scientific notation parses as the intended number (parseFloat, not parseInt)', () => {
    // parseInt('1e6') === 1 — that would turn "a million" into a one-token cap.
    expect(getOrgBudgetConfig({ ORG_DAILY_TOKEN_BUDGET: '1e6' }).tokens).toBe(1_000_000)
  })

  test('invalid env yields a decision that never touches the db', async () => {
    const decision = await checkOrgBudget('org1', getOrgBudgetConfig({ ORG_DAILY_TOKEN_BUDGET: 'abc' }))
    expect(decision.limited).toBe(false)
    expect(aggregateMock).not.toHaveBeenCalled()
  })
})

describe('orgBudgetExceededMessage', () => {
  test('token refusal names the limit and the used amount', async () => {
    setUsage(700, 500, 3)
    const decision = await checkOrgBudget('org1', TOKENS_ONLY)
    const message = orgBudgetExceededMessage(decision)
    expect(message).toContain('1000')
    expect(message).toContain('1200')
    expect(message).toContain('tokens')
    expect(message).not.toContain('requests')
  })

  test('request refusal names the limit and the used amount', async () => {
    setUsage(100, 50, 87)
    const decision = await checkOrgBudget('org1', REQUESTS_ONLY)
    const message = orgBudgetExceededMessage(decision)
    expect(message).toContain('50')
    expect(message).toContain('87')
    expect(message).toContain('requests')
  })

  test('an unlimited decision has no refusal text', async () => {
    const decision = await checkOrgBudget('org1')
    expect(orgBudgetExceededMessage(decision)).toBe('')
  })
})
