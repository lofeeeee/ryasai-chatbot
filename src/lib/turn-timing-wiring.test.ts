import { describe, expect, mock, test } from 'bun:test'

// The collector is only useful if EVERY LLM call reaches it. `logLlmUsage` is the one place all
// calls pass through, so the wiring is tested there — against the real function, with only its
// side-effecting neighbours (trace buffer, DB) replaced.
mock.module('@/lib/observability', () => ({ traceLlmCall: () => {} }))
mock.module('@/lib/db', () => ({ db: { llmUsageLog: { create: () => Promise.resolve({}) } } }))
mock.module('@/lib/prisma-tenant', () => ({ getOrgContext: () => 'org-1', requireOrgContext: () => 'org-1' }))

const { logLlmUsage } = await import('./llm-client-utils')
const { enterTurnTiming, summarizeTurn } = await import('./turn-timing')

const cfg = { provider: 'OPENAI_COMPATIBLE', model: 'm' } as never

describe('logLlmUsage → turn timing', () => {
  test('a call WITH usage is reported to the open turn', async () => {
    await Promise.resolve().then(() => {
      enterTurnTiming(0)
      logLlmUsage('rag-rerank', cfg, { promptTokens: 10, completionTokens: 5, totalTokens: 15 } as never, 700)
      expect(summarizeTurn(10_000, 10_000)!.byPurpose['rag-rerank']).toEqual({ calls: 1, ms: 700 })
    })
  })

  test('a call with NO usage still counts: it cost the user wall-clock time', async () => {
    // The early-return on missing usage sits right after the report. A report placed below it would
    // silently drop exactly the calls whose providers omit token counts.
    await Promise.resolve().then(() => {
      enterTurnTiming(0)
      logLlmUsage('intent-analysis', cfg, null, 1_200)
      expect(summarizeTurn(10_000, 10_000)!.byPurpose['intent-analysis']).toEqual({ calls: 1, ms: 1_200 })
    })
  })

  test('outside a turn the call is simply not recorded and nothing throws', async () => {
    await Promise.resolve().then(() => {
      expect(() => logLlmUsage('title', cfg, null, 50)).not.toThrow()
    })
  })
})
