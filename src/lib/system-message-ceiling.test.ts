import { describe, expect, test, beforeEach, afterEach, spyOn } from 'bun:test'
import {
  PROVIDER_SYSTEM_MESSAGE_CEILING,
  SYSTEM_MESSAGE_BUDGET,
  assertSystemMessagesUnderCeiling,
  assertSystemPromptUnderCeiling,
  orgSystemPrefixMessage,
  resetSystemCeilingWarnings,
  systemFitsBudget,
  systemTextLength,
} from './system-message-ceiling'

/**
 * The guard exists so an over-long system message FAILS HERE rather than in production behaviour.
 *
 * MEASURED cliff (this deployment's BYOK endpoint): a `role:'system'` message above ~2000
 * characters is discarded WHOLE — 1800 chars reports `prompt_tokens` 411, 2100+ reports 44 (the
 * user message alone), 3/3 reproducible. That is silent-failure class 11: an instruction never
 * DELIVERED, which presents as a model ignoring its prompt. It has already cost this repo twice
 * (Text-to-SQL rules 3033 chars, intent prompt 2872 chars).
 *
 * Every test below is negative-controlled by construction where it can be: the length assertions
 * pin BOTH sides of the boundary, and the warn assertions read the actual emitted payload, so a
 * guard that always returns `ok: true` fails rather than passing quietly.
 */
describe('system-message ceiling — the measured boundary', () => {
  let warnSpy: ReturnType<typeof spyOn>

  beforeEach(() => {
    resetSystemCeilingWarnings()
    warnSpy = spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    warnSpy.mockRestore()
    resetSystemCeilingWarnings()
  })

  test('the enforced budget is BELOW the measured cliff, deliberately', () => {
    // The cliff is only located to within 100 characters (between 2000 and 2100), and a prompt
    // sitting exactly at a measured boundary spends its life one edit away from being dropped.
    // If someone raises the budget to the cliff, this fails.
    expect(SYSTEM_MESSAGE_BUDGET).toBeLessThan(PROVIDER_SYSTEM_MESSAGE_CEILING)
  })

  test('a message AT the ceiling passes, one character OVER fails', () => {
    // Pins both sides: an off-by-one guard would silently allow the first dropped size, and a
    // guard with no upper tolerance would reject a legitimate prompt.
    const at = assertSystemPromptUnderCeiling('x'.repeat(PROVIDER_SYSTEM_MESSAGE_CEILING), 'at')
    expect(at.ok).toBe(true)
    expect(at.length).toBe(PROVIDER_SYSTEM_MESSAGE_CEILING)

    const over = assertSystemPromptUnderCeiling('x'.repeat(PROVIDER_SYSTEM_MESSAGE_CEILING + 1), 'over')
    expect(over.ok).toBe(false)
    expect(over.length).toBe(PROVIDER_SYSTEM_MESSAGE_CEILING + 1)
    expect(over.ceiling).toBe(PROVIDER_SYSTEM_MESSAGE_CEILING)
  })

  test('an over-ceiling message WARNS once, and the warning names the real numbers', () => {
    const label = 'unit-test:over'
    const length = PROVIDER_SYSTEM_MESSAGE_CEILING + 423
    assertSystemPromptUnderCeiling('x'.repeat(length), label)
    // The second call must NOT print again — a prompt over the ceiling on every request would
    // otherwise emit a line per request. Warn-once is the property, so it is asserted.
    assertSystemPromptUnderCeiling('x'.repeat(length), label)

    expect(warnSpy).toHaveBeenCalledTimes(1)
    const payload = JSON.parse(String(warnSpy.mock.calls[0]![0])) as Record<string, unknown>
    expect(payload.label).toBe(label)
    expect(payload.length).toBe(length)
    expect(payload.ceiling).toBe(PROVIDER_SYSTEM_MESSAGE_CEILING)
    expect(payload.over).toBe(423)
    // The message must say what to DO, not just that a number was exceeded — this warning is the
    // only thing standing between "quietly dropped prompt" and a diagnosable one.
    expect(String(payload.msg)).toMatch(/USER message/i)
  })

  test('a message under the ceiling never warns', () => {
    assertSystemPromptUnderCeiling('short', 'unit-test:clean')
    expect(warnSpy).not.toHaveBeenCalled()
  })

  test('the JOINED system text is what gets measured — the wire joins system messages', () => {
    // `buildAnthropicBody` concatenates every system message into ONE `system` text block, so
    // three messages of 700 characters are a single 2100-character system message on the wire.
    // A per-message guard would pass all three and the provider would drop the joint block.
    const messages = [
      { role: 'system', content: 'x'.repeat(700) },
      { role: 'user', content: 'ignored' },
      { role: 'system', content: 'y'.repeat(700) },
      { role: 'system', content: 'z'.repeat(700) },
    ]
    expect(systemTextLength(messages)).toBe(700 * 3 + 2 * 2)
    expect(assertSystemMessagesUnderCeiling(messages, 'unit-test:joined').ok).toBe(false)
    expect(warnSpy).toHaveBeenCalledTimes(1)
    const payload = JSON.parse(String(warnSpy.mock.calls[0]![0])) as Record<string, unknown>
    expect(payload.length).toBe(2104)
    expect(String(payload.msg)).toMatch(/JOINED/)
  })

  test('the same text as USER messages is not measured at all — there is no ceiling there', () => {
    // The whole fix rests on this asymmetry, so it is pinned: user content, however long, is not
    // part of the system budget.
    const messages = [{ role: 'user', content: 'x'.repeat(50000) }]
    expect(systemTextLength(messages)).toBe(0)
    expect(assertSystemMessagesUnderCeiling(messages, 'unit-test:user-only').ok).toBe(true)
    expect(warnSpy).not.toHaveBeenCalled()
  })

  test('systemFitsBudget accounts for the join separator', () => {
    expect(systemFitsBudget('x'.repeat(100), 'y'.repeat(100), 202)).toBe(true)
    expect(systemFitsBudget('x'.repeat(100), 'y'.repeat(100), 201)).toBe(false)
  })
})

describe('orgSystemPrefixMessage — the org prefix, bounded at the read path', () => {
  let warnSpy: ReturnType<typeof spyOn>

  beforeEach(() => {
    resetSystemCeilingWarnings()
    warnSpy = spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    warnSpy.mockRestore()
    resetSystemCeilingWarnings()
  })

  const ASSISTANT_BLOCK = 'You are ryasai, an enterprise AI assistant. '.repeat(5)

  test('a prefix that fits stays a SYSTEM message with its text untouched', () => {
    const prefix = 'You are a sales analyst. Be concise.'
    const msg = orgSystemPrefixMessage(prefix, 'unit-test:fits', ASSISTANT_BLOCK)
    expect(msg.role).toBe('system')
    expect(msg.content).toBe(prefix)
    expect(warnSpy).not.toHaveBeenCalled()
  })

  test('an over-long prefix is DEMOTED to a user message, and NOT one character is lost', () => {
    // The two properties that matter, and they pull in opposite directions: the system budget must
    // hold, AND the operator's instructions must still arrive in full. Truncating would satisfy the
    // first and break the second — which is why demotion is the fix rather than a slice().
    const prefix = 'ORG RULE: never mention competitor pricing. ' + 'z'.repeat(9000)
    const msg = orgSystemPrefixMessage(prefix, 'unit-test:demoted', ASSISTANT_BLOCK)
    expect(msg.role).toBe('user')
    expect(msg.content).toContain(prefix)
    // The demoted carrier must not read as a system directive, since that is the authority it lost.
    expect(msg.content.toLowerCase()).toContain('operator instructions')
    expect(warnSpy).toHaveBeenCalledTimes(1)
    const payload = JSON.parse(String(warnSpy.mock.calls[0]![0])) as Record<string, unknown>
    expect(payload.prefixLength).toBe(prefix.length)
    expect(payload.budget).toBe(SYSTEM_MESSAGE_BUDGET)
  })

  test('the demotion threshold is the JOINT budget, not a fixed prefix length', () => {
    // The same prefix is fine next to a short block and too long next to a long one. A guard that
    // only measured the prefix would let a big assistant block push the joint total over anyway.
    const prefix = 'x'.repeat(SYSTEM_MESSAGE_BUDGET - 100)
    expect(orgSystemPrefixMessage(prefix, 'unit-test:t1', '').role).toBe('system')
    resetSystemCeilingWarnings()
    expect(orgSystemPrefixMessage(prefix, 'unit-test:t2', 'y'.repeat(200)).role).toBe('user')
  })

  test('warns once per label, not once per request', () => {
    const prefix = 'z'.repeat(9000)
    orgSystemPrefixMessage(prefix, 'unit-test:once', ASSISTANT_BLOCK)
    orgSystemPrefixMessage(prefix, 'unit-test:once', ASSISTANT_BLOCK)
    orgSystemPrefixMessage(prefix, 'unit-test:once', ASSISTANT_BLOCK)
    expect(warnSpy).toHaveBeenCalledTimes(1)
  })
})
