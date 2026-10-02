import { describe, expect, test } from 'bun:test'
import { chooseAvailableDecision } from '@/lib/tool-router'
import {
  evaluateToolPolicy,
  type ToolAction,
  type ToolPolicyInput,
} from '@/lib/tool-policy'

/**
 * AGREEMENT HARNESS — how `applyToolGating` is reached from this file.
 *
 * `applyToolGating` itself is NOT exported by tool-router.ts (it is the file's
 * private consolidation of the two duplicated gates; the repo's own
 * tool-router.test.ts notes the same). Its EXPORTED half is
 * `chooseAvailableDecision`, and the private half is three unconditional
 * statements on the tool toggles, read verbatim from tool-router.ts:576-588:
 *
 *   let effective = chooseAvailableDecision(decision, availability)
 *   if (effective === 'SQL' && !tools.sql) effective = 'CHAT'
 *   if (effective === 'RAG' && !tools.rag) effective = 'CHAT'
 *   if (effective === 'REST' && !tools.restApi) effective = 'CHAT'
 *
 * So the harness calls the REAL exported function and appends those three
 * statements, making every rule the production code applies come from the
 * production module graph. tool-router.ts IS importable under `bun test` (its
 * module graph of db/llm modules loads without a DB — this was probed before
 * writing this file), so no replication of `chooseAvailableDecision` is needed
 * and the discrepancy risk is confined to the three toggle lines quoted above.
 * If tool-router.ts ever changes those, the agreement table below fails and
 * points here.
 */
type RouteDecision = 'SQL' | 'RAG' | 'REST' | 'CHAT' | 'PLUGIN' | 'CONTEXTUAL_CHAT'

function applyToolGating(
  decision: RouteDecision,
  availability: { hasIntegrations: boolean; hasDocuments: boolean; hasRestApis: boolean },
  tools: { sql: boolean; rag: boolean; restApi: boolean },
): RouteDecision {
  let effective = chooseAvailableDecision(decision, availability)
  if (effective === 'SQL' && !tools.sql) effective = 'CHAT'
  if (effective === 'RAG' && !tools.rag) effective = 'CHAT'
  if (effective === 'REST' && !tools.restApi) effective = 'CHAT'
  return effective
}

/** tool-router's RouteDecision, which this policy names in lower case with a hyphen. */
const ROUTE_FOR_ACTION: Record<ToolAction, RouteDecision> = {
  sql: 'SQL',
  rag: 'RAG',
  rest: 'REST',
  plugin: 'PLUGIN',
  chat: 'CHAT',
  'contextual-chat': 'CONTEXTUAL_CHAT',
}

const ALL_PRESENT = { hasIntegrations: true, hasDocuments: true, hasRestApis: true }

describe('tool-policy — denial reasons name the failed precondition and the tool', () => {
  test('sql denied for absent integrations', () => {
    const [d] = evaluateToolPolicy({
      action: 'sql',
      available: { hasIntegrations: false, hasDocuments: true, hasRestApis: true },
      tools: { sql: true, rag: true, restApi: true },
    })
    expect(d.allowed).toBe(false)
    expect(d.downgradeFrom).toBe('sql')
    expect(d.action).toBe('chat')
    expect(d.reason).toContain('integration')
    expect(d.reason.toLowerCase()).toContain('sql')
  })

  test('sql denied for the operator toggle', () => {
    const [d] = evaluateToolPolicy({
      action: 'sql',
      available: ALL_PRESENT,
      tools: { sql: false, rag: true, restApi: true },
    })
    expect(d.allowed).toBe(false)
    expect(d.downgradeFrom).toBe('sql')
    expect(d.action).toBe('chat')
    expect(d.reason).toContain('disabled')
    expect(d.reason.toLowerCase()).toContain('sql')
    // The two failure modes must be distinguishable in the audit trail.
    expect(d.reason).not.toContain('no integration')
  })

  test('rag denied for absent documents', () => {
    const [d] = evaluateToolPolicy({
      action: 'rag',
      available: { hasIntegrations: true, hasDocuments: false, hasRestApis: true },
      tools: { sql: true, rag: true, restApi: true },
    })
    expect(d.allowed).toBe(false)
    expect(d.downgradeFrom).toBe('rag')
    expect(d.action).toBe('chat')
    expect(d.reason).toContain('document')
    expect(d.reason.toLowerCase()).toContain('rag')
  })

  test('rag denied for absent documents under a documents pin says the pin', () => {
    const [d] = evaluateToolPolicy({
      action: 'rag',
      available: { hasIntegrations: true, hasDocuments: false, hasRestApis: true },
      tools: { sql: true, rag: true, restApi: true },
      pinToDocuments: true,
    })
    expect(d.allowed).toBe(false)
    expect(d.downgradeFrom).toBe('rag')
    expect(d.reason).toContain('pinned documents')
    expect(d.reason).toContain('document')
    expect(d.reason.toLowerCase()).toContain('rag')
  })

  test('rag denied for the operator toggle', () => {
    const [d] = evaluateToolPolicy({
      action: 'rag',
      available: ALL_PRESENT,
      tools: { sql: true, rag: false, restApi: true },
    })
    expect(d.allowed).toBe(false)
    expect(d.downgradeFrom).toBe('rag')
    expect(d.action).toBe('chat')
    expect(d.reason).toContain('disabled')
    expect(d.reason.toLowerCase()).toContain('rag')
  })

  test('rest denied for absent REST endpoints', () => {
    const [d] = evaluateToolPolicy({
      action: 'rest',
      available: { hasIntegrations: true, hasDocuments: true, hasRestApis: false },
      tools: { sql: true, rag: true, restApi: true },
    })
    expect(d.allowed).toBe(false)
    expect(d.downgradeFrom).toBe('rest')
    expect(d.action).toBe('chat')
    expect(d.reason).toContain('REST endpoint')
    expect(d.reason.toLowerCase()).toContain('rest')
  })

  test('rest denied for the operator toggle', () => {
    const [d] = evaluateToolPolicy({
      action: 'rest',
      available: ALL_PRESENT,
      tools: { sql: true, rag: true, restApi: false },
    })
    expect(d.allowed).toBe(false)
    expect(d.downgradeFrom).toBe('rest')
    expect(d.action).toBe('chat')
    expect(d.reason).toContain('disabled')
    expect(d.reason.toLowerCase()).toContain('rest')
  })

  test('a pinned database with no integration names the pin in the reason', () => {
    const [d] = evaluateToolPolicy({
      action: 'sql',
      available: { hasIntegrations: false, hasDocuments: true, hasRestApis: true },
      tools: { sql: true, rag: true, restApi: true },
      userPinnedIntegration: true,
    })
    expect(d.allowed).toBe(false)
    expect(d.reason).toContain('pinned')
    expect(d.reason).toContain('integration')
  })
})

describe('tool-policy — agreement with applyToolGating (32-case table, no pins)', () => {
  // Full cross-product: 8 availability combinations x 4 tool-settings shapes.
  const availabilityCases: Array<{ hasIntegrations: boolean; hasDocuments: boolean; hasRestApis: boolean }> = []
  for (const hasIntegrations of [true, false])
    for (const hasDocuments of [true, false])
      for (const hasRestApis of [true, false])
        availabilityCases.push({ hasIntegrations, hasDocuments, hasRestApis })

  const toolsCases: Array<{
    label: string
    tools?: { sql: boolean; rag: boolean; restApi: boolean }
  }> = [
    { label: 'tools undefined', tools: undefined },
    { label: 'all on', tools: { sql: true, rag: true, restApi: true } },
    { label: 'sql off', tools: { sql: false, rag: true, restApi: true } },
    { label: 'rag off', tools: { sql: true, rag: false, restApi: true } },
    { label: 'rest off', tools: { sql: true, rag: true, restApi: false } },
  ]

  // `applyToolGating` takes a REQUIRED tools object (prompt-settings always
  // resolves one); "tools undefined" means the caller did not override the
  // defaults, which the policy reads as "no toggle is off".
  const resolvedTools = (tools?: { sql: boolean; rag: boolean; restApi: boolean }) =>
    tools ?? { sql: true, rag: true, restApi: true }

  const actions: ToolAction[] = ['sql', 'rag', 'rest', 'plugin', 'chat', 'contextual-chat']

  for (const available of availabilityCases) {
    for (const { label, tools } of toolsCases) {
      const name = `${available.hasIntegrations ? 'int' : 'no-int'}/${available.hasDocuments ? 'doc' : 'no-doc'}/${available.hasRestApis ? 'rest' : 'no-rest'}, ${label}`
      test(name, () => {
        for (const action of actions) {
          const input: ToolPolicyInput = { action, available, ...(tools ? { tools } : {}) }
          const [decision] = evaluateToolPolicy(input)
          const gated = applyToolGating(ROUTE_FOR_ACTION[action], available, resolvedTools(tools))
          // The FINAL action must agree exactly, modulo the vocabulary: this
          // policy speaks `ToolAction` (lower case, hyphenated) while the
          // router speaks `RouteDecision`. The mapping is the bijection in
          // ROUTE_FOR_ACTION, so comparing through it is comparing the action,
          // not the spelling.
          expect(`${name} [${action}] -> ${ROUTE_FOR_ACTION[decision.action]}`).toBe(`${name} [${action}] -> ${gated}`)
          expect(decision.allowed).toBe(decision.action !== 'chat' || action === 'chat')
          expect(typeof decision.reason).toBe('string')
          expect(decision.reason.length).toBeGreaterThan(0)
          if (!decision.allowed) {
            expect(decision.downgradeFrom).toBe(action)
            expect(decision.action).toBe('chat')
          } else {
            expect(decision.downgradeFrom).toBeUndefined()
          }
        }
      })
    }
  }
})

describe('tool-policy — compound requests get one decision per requested source', () => {
  test('two requested sources where one is denied', () => {
    const decisions = evaluateToolPolicy({
      action: 'sql',
      available: { hasIntegrations: true, hasDocuments: false, hasRestApis: true },
      tools: { sql: true, rag: true, restApi: true },
      compoundExtraTools: ['rag'],
    })
    expect(decisions).toHaveLength(2)
    // The SQL half is allowed and keeps its action.
    expect(decisions[0].action).toBe('sql')
    expect(decisions[0].allowed).toBe(true)
    expect(decisions[0].downgradeFrom).toBeUndefined()
    // The RAG half is denied, carries the downgrade, and lands on chat.
    expect(decisions[1]).toMatchObject({ action: 'chat', allowed: false, downgradeFrom: 'rag' })
    expect(decisions.filter((d) => !d.allowed)).toHaveLength(1)
  })

  test('the denied half of a compound request names its own precondition', () => {
    const decisions = evaluateToolPolicy({
      action: 'rest',
      available: { hasIntegrations: true, hasDocuments: true, hasRestApis: false },
      compoundExtraTools: ['sql'],
    })
    expect(decisions[0].allowed).toBe(false)
    expect(decisions[0].reason).toContain('REST endpoint')
    expect(decisions[1].allowed).toBe(true)
    expect(decisions[1].reason.toLowerCase()).toContain('sql')
  })

  test('extra tool ids from the selector map to their actions, plugin prefix included', () => {
    // tool-selector's routeForTool maps `plugin:*` and `mcp:*` by PREFIX; an
    // exact-name table there once dropped plugin calls on the floor.
    const decisions = evaluateToolPolicy({
      action: 'rag',
      available: ALL_PRESENT,
      compoundExtraTools: ['plugin:weather', 'mcp:wiki', 'web_search', 'bogus_tool_id'],
    })
    expect(decisions.map((d) => d.action)).toEqual(['rag', 'plugin', 'plugin', 'plugin', 'chat'])
    expect(decisions.every((d) => d.allowed)).toBe(true)
  })

  test('extra tools inherit the same toggles and availability as the primary', () => {
    const decisions = evaluateToolPolicy({
      action: 'chat',
      available: { hasIntegrations: false, hasDocuments: true, hasRestApis: true },
      tools: { sql: true, rag: true, restApi: true },
      compoundExtraTools: ['sql'],
    })
    expect(decisions[0]).toMatchObject({ action: 'chat', allowed: true })
    expect(decisions[1]).toMatchObject({ action: 'chat', allowed: false, downgradeFrom: 'sql' })
    expect(decisions[1].reason).toContain('integration')
  })
})

describe('tool-policy — unconditional routes and purity', () => {
  test('plugin, chat and contextual-chat are allowed with a stated reason', () => {
    const nothing = { hasIntegrations: false, hasDocuments: false, hasRestApis: false }
    for (const action of ['plugin', 'chat', 'contextual-chat'] as ToolAction[]) {
      const [d] = evaluateToolPolicy({ action, available: nothing })
      expect(d.allowed).toBe(true)
      expect(d.downgradeFrom).toBeUndefined()
      expect(d.reason).toContain('no precondition')
    }
  })

  test('every allowed decision across the full cross-product has a non-empty reason', () => {
    const seen: Array<{ action: ToolAction; reason: string }> = []
    for (const hasIntegrations of [true, false])
      for (const hasDocuments of [true, false])
        for (const hasRestApis of [true, false])
          for (const tools of [undefined, { sql: true, rag: true, restApi: true }]) {
            for (const action of ['sql', 'rag', 'rest', 'plugin', 'chat', 'contextual-chat'] as ToolAction[]) {
              for (const d of evaluateToolPolicy({ action, available: { hasIntegrations, hasDocuments, hasRestApis }, tools }))
                seen.push({ action: d.action, reason: d.reason })
            }
          }
    expect(seen.length).toBeGreaterThan(0)
    for (const { reason } of seen) expect(reason.length).toBeGreaterThan(0)
  })

  test('no DB, no async, no env: the module is a pure function of its arguments', () => {
    // Static negative control in the spirit of the repo's invariants tests.
    // Comments are stripped FIRST, because the policy's own doc block says
    // "no DB, no env, no async" and a bare pattern would match that prose and
    // never fail — the exact "guard satisfied by a comment" class AGENTS.md
    // records for the instrumentation guard.
    const source = stripComments(readThisFile())
    expect(source).not.toMatch(/\bfrom\s+'@\/lib\/db'/)
    expect(source).not.toMatch(/\bfrom\s+'@\/lib\/prisma/)
    expect(source).not.toMatch(/\bprocess\.env\b/)
    expect(source).not.toMatch(/\basync\b|\bawait\b/)
    expect(source).not.toMatch(/\bfetch\s*\(/)
    expect(source).not.toMatch(/\bDate\.now\b|\bnew Date\b/)
    expect(source).not.toMatch(/\bMath\.random\b/)
    // And the happy path is observably synchronous: no promise is returned.
    const out = evaluateToolPolicy({ action: 'sql', available: ALL_PRESENT })
    expect(out).toBeInstanceOf(Array)
    expect(out[0] instanceof Promise).toBe(false)
  })
})

/** Reads this test file's own text, so the purity test asserts the policy file — not itself. */
function readThisFile(): string {
  // The sibling module is loaded as TEXT, not imported, because the assertion
  // is about what the policy must never contain.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('node:fs').readFileSync(require('node:path').join(__dirname, 'tool-policy.ts'), 'utf8') as string
}

/** Strips // and /* *‍/ comments, per AGENTS.md's rule that a guard must not be satisfiable by prose. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}
