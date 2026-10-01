import { describe, expect, test } from 'bun:test'
import { enterTurnTiming, recordTurnLlmCall, recordTurnMetrics, summarizeTurn } from './turn-timing'

// `enterTurnTiming` uses AsyncLocalStorage.enterWith, which binds to the CURRENT async
// execution. Each test therefore runs its body inside its own async function so one
// test's collector cannot be read by the next.
const isolated = (fn: () => void | Promise<void>) => async () => {
  await Promise.resolve().then(fn)
}

describe('turn timing', () => {
  test('outside a turn there is nothing to summarise and reporting is a no-op', async () => {
    await isolated(() => {
      expect(() => recordTurnLlmCall('rag', 100)).not.toThrow()
      expect(summarizeTurn(null)).toBeNull()
    })()
  })

  test('counts only the calls that FINISHED before the first token', isolated(() => {
    enterTurnTiming(1_000)
    recordTurnLlmCall('query-rewrite', 2_000, 3_000) // ended at +2000
    recordTurnLlmCall('intent-analysis', 1_500, 4_500) // ended at +3500
    recordTurnLlmCall('synthesis', 2_500, 9_000) // ended at +8000, AFTER the first token
    const t = summarizeTurn(6_000, 10_000)!
    expect(t.firstTokenMs).toBe(5_000)
    expect(t.totalMs).toBe(9_000)
    expect(t.preTokenLlmCalls).toBe(2)
    expect(t.preTokenLlmMs).toBe(3_500)
    expect(t.preTokenOtherMs).toBe(1_500)
  }))

  test('groups every call by purpose, including the post-token ones', isolated(() => {
    enterTurnTiming(0)
    recordTurnLlmCall('agent', 100, 100)
    recordTurnLlmCall('agent', 300, 500)
    recordTurnLlmCall('reflection', 50, 600)
    const t = summarizeTurn(10_000, 10_000)!
    expect(t.byPurpose.agent).toEqual({ calls: 2, ms: 400 })
    expect(t.byPurpose.reflection).toEqual({ calls: 1, ms: 50 })
  }))

  test('a turn that never produced a token charges the whole turn as the wait', isolated(() => {
    enterTurnTiming(0)
    recordTurnLlmCall('intent-analysis', 1_000, 1_000)
    const t = summarizeTurn(null, 4_000)!
    expect(t.firstTokenMs).toBe(4_000)
    expect(t.preTokenLlmCalls).toBe(1)
    expect(t.preTokenOtherMs).toBe(3_000)
  }))

  test('parallel calls cannot drive "other" time negative', isolated(() => {
    enterTurnTiming(0)
    // Two calls of 3000ms that overlapped inside a 3500ms window: summed they exceed the wall clock.
    recordTurnLlmCall('a', 3_000, 3_000)
    recordTurnLlmCall('b', 3_000, 3_400)
    const t = summarizeTurn(3_500, 3_500)!
    expect(t.preTokenLlmMs).toBe(6_000)
    expect(t.preTokenOtherMs).toBe(0)
  }))

  test('a negative or fractional duration is clamped, not recorded verbatim', isolated(() => {
    enterTurnTiming(0)
    recordTurnLlmCall('a', -50, 100)
    recordTurnLlmCall('b', 12.6, 200)
    const t = summarizeTurn(1_000, 1_000)!
    expect(t.byPurpose.a.ms).toBe(0)
    expect(t.byPurpose.b.ms).toBe(13)
  }))

  test('concurrent turns do not see each other\'s calls', async () => {
    const run = (name: string, ms: number) =>
      Promise.resolve().then(async () => {
        enterTurnTiming(0)
        await new Promise((r) => setTimeout(r, 5))
        recordTurnLlmCall(name, ms, ms)
        await new Promise((r) => setTimeout(r, 5))
        return summarizeTurn(10_000, 10_000)!
      })
    const [a, b] = await Promise.all([run('only-in-a', 100), run('only-in-b', 200)])
    expect(Object.keys(a.byPurpose)).toEqual(['only-in-a'])
    expect(Object.keys(b.byPurpose)).toEqual(['only-in-b'])
  })

  test('recording metrics never throws', () => {
    expect(() =>
      recordTurnMetrics({ firstTokenMs: 1, totalMs: 2, preTokenLlmCalls: 3, preTokenLlmMs: 4, preTokenOtherMs: 5, byPurpose: {} }),
    ).not.toThrow()
  })
})
