import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'
import { ORG_SCOPED_MODELS, ORG_SCOPE_EXCEPTIONS } from './prisma-tenant'

/**
 * TENANT SCOPE COVERAGE — the guard that would have caught the `Order` IDOR.
 *
 * ===========================================================================
 * WHAT WAS MISSING, AND WHY EVERY EXISTING GUARD MISSED IT
 * ===========================================================================
 *
 * `prisma/schema.prisma` had 30 models carrying `organizationId`, while
 * `ORG_SCOPED_MODELS` in `src/lib/prisma-tenant.ts` listed 28. `Order` was one of
 * the two missing, and the omission was a LIVE cross-tenant IDOR:
 *
 *     GET /api/billing/orders/<any-order-id-in-the-install>
 *       -> 200 { status, months, amountIdr, licenseIssued } of ANOTHER ORG's order
 *
 * Measured by driving the real `$allOperations` handler and reading the SQL
 * Prisma emitted, in the same process, for the same shape of query:
 *
 *     Document.findFirst -> WHERE (id = $1 AND organizationId = $2)   <- scoped
 *     Order.findFirst    -> WHERE  id = $1                            <- NOT scoped
 *
 * Before this file, the repo had TWENTY-FOUR assertions referencing
 * `ORG_SCOPED_MODELS`, and every single one checked a PARTICULAR model was in the
 * set ("`ScheduledRunLog` is in ORG_SCOPED_MODELS", read from source). Not one
 * checked that the set was COMPLETE. `invariants.test.ts` enforced the OPERATION
 * dimension (`findUnique` vs `findFirst`, with an allowlist) and
 * `tenant-route-guard.test.ts` enforced the RITUAL dimension (`enterWithOrg` per
 * route). Both were green while `Order` leaked, because the leak was neither: the
 * route used the correct operation and called the correct ritual, and the
 * extension simply never fired for that model.
 *
 * So this guard covers the third dimension — MODEL MEMBERSHIP — by deriving the
 * answer from the schema instead of trusting a hand-written list. A hand-written
 * list is exactly what failed: `Order` was added to the schema in 2026-09 and the
 * set was not updated with it, and nothing could notice.
 *
 * ===========================================================================
 * WHY IT PARSES THE SCHEMA AND DOES NOT IMPORT A GENERATED CLIENT
 * ===========================================================================
 *
 * The comparison must be schema-vs-set. A guard that read the *generated Prisma
 * client* would measure a different artifact from the one under review (CI
 * regenerates it; `.prisma/` is gitignored and can be stale), and a guard that
 * read a second hand-written list would drift in exactly the way being guarded.
 * `prisma/schema.prisma` is the only source that cannot lie about which models
 * carry `organizationId`.
 *
 * ===========================================================================
 * WHY THE EXCEPTION LIST IS IMPORTED, NOT REPEATED
 * ===========================================================================
 *
 * `ORG_SCOPE_EXCEPTIONS` is exported from `prisma-tenant.ts` so this file does not
 * carry a copy. A copy would be a second hand-written list — the same shape of
 * artifact that let `Order` through — and the two would disagree silently.
 */

// ---------------------------------------------------------------------------
// Schema parsing
// ---------------------------------------------------------------------------

/**
 * Models in `prisma/schema.prisma`, mapped to whether they declare
 * `organizationId String`.
 *
 * Parsed by brace-depth block matching rather than by regex over the whole file,
 * for a reason that is not hypothetical: a naive `/^model\s+(\w+)/m` scan also
 * matches a FIELD named `model` (LlmConfig has `model String`), and a naive
 * `[^}]*` block body stops at the first `}` — which appears inside comments and
 * `Unsupported("...")` types. Both bugs produce a plausible-looking model list
 * with models silently missing, which is the failure this guard exists to catch.
 * A guard that under-reports models is worse than no guard: it reports safety.
 *
 * Deliberately does NOT strip comments before looking for `organizationId`: a
 * commented-out field would require the `String` type token to match, so
 * `// organizationId String` is not realistic, while stripping comments risks
 * eating real content (block comments contain `}`). Matching `^\s*organizationId\s+String\b`
 * anchored to a line start inside a known model block is precise enough.
 */
function parseSchemaModels(source: string): Map<string, boolean> {
  const models = new Map<string, boolean>()
  const lines = source.split('\n')

  let current: string | null = null
  let hasOrgId = false

  const flush = () => {
    if (current !== null) models.set(current, hasOrgId)
    current = null
    hasOrgId = false
  }

  for (const raw of lines) {
    const line = raw.trim()

    // A model header must be `model Name {` and nothing else on the line, so a
    // `model String` FIELD can never start a block.
    const header = /^model\s+(\w+)\s*\{\s*$/.exec(line)
    if (header) {
      flush()
      current = header[1]!
      continue
    }
    if (current !== null && line === '}') {
      flush()
      continue
    }
    if (current !== null && /^organizationId\s+String\b/.test(line)) {
      hasOrgId = true
    }
  }
  flush()

  return models
}

const SCHEMA_PATH = join(import.meta.dir, '..', '..', 'prisma', 'schema.prisma')
const schemaSource = readFileSync(SCHEMA_PATH, 'utf8')

/** `Order` -> `order`, the key format the extension matches on. */
function modelKey(name: string): string {
  return name.charAt(0).toLowerCase() + name.slice(1)
}

const schemaModels = parseSchemaModels(schemaSource)
const schemaOrgScopedModels = [...schemaModels.entries()]
  .filter(([, hasOrgId]) => hasOrgId)
  .map(([name]) => name)
const schemaOrgScopedKeys = schemaOrgScopedModels.map(modelKey).sort()

const declaredScopedKeys = [...ORG_SCOPED_MODELS].sort()
const exceptionKeys = Object.keys(ORG_SCOPE_EXCEPTIONS).sort()

/** What the extension's set SHOULD contain: every schema model with organizationId. */
const accountedForKeys = [...declaredScopedKeys, ...exceptionKeys].sort()

// ---------------------------------------------------------------------------
// The parser is itself a guard input, so it gets a negative control
// ---------------------------------------------------------------------------

describe('schema parser — the guard input is trustworthy', () => {
  test('it finds every model header, cross-checked by a SECOND independent parse', () => {
    // The main assertion compares two derived sets, so a parser that under-reported
    // models could still "match" — so this must not be the only check on the parser.
    //
    // Cross-checked with a different method rather than a pinned literal: a simple
    // line regex counts `model X {` headers, and that count must equal the block
    // parser's. A pinned count would fail spuriously whenever a model is added
    // WITHOUT `organizationId` (a legitimate change the main guard should allow);
    // agreement between two methods fails only when the parser is actually wrong.
    const headerCount = schemaSource
      .split('\n')
      .filter((l) => /^model\s+\w+\s*\{\s*$/.test(l.trim())).length
    expect(schemaModels.size).toBe(headerCount)
    // And a floor, so a degradation that made BOTH methods find nothing cannot agree
    // its way to green. 31 models at the time of writing.
    expect(schemaModels.size).toBeGreaterThanOrEqual(31)
  })

  test('`model String` as a FIELD does not start a block (LlmConfig regression)', () => {
    // LlmConfig declares `model String`. A `/^model\s+(\w+)/` parser records a
    // phantom model named "String" and, worse, can swallow the real block after it.
    expect(schemaModels.has('String')).toBe(false)
    expect(schemaModels.has('LlmConfig')).toBe(true)
    expect(schemaModels.get('LlmConfig')).toBe(true) // LlmConfig.organizationId IS declared
  })

  test('a model with NO organizationId is recorded as false, not omitted', () => {
    // `Organization` is the tenant root and has no `organizationId` column. It must
    // be present-with-false: absent would mean the parser dropped it, and the
    // exclusion logic below depends on distinguishing the two.
    expect(schemaModels.has('Organization')).toBe(true)
    expect(schemaModels.get('Organization')).toBe(false)
  })

  test('the two Unsupported() columns do not truncate a block', () => {
    // `Unsupported("vector(384)")` and `Unsupported("tsvector")` sit inside
    // DocumentChunk, which has organizationId AFTER them in field order. A parser
    // that stopped at the first `)` or `}` would report no organizationId here.
    expect(schemaModels.get('DocumentChunk')).toBe(true)
    expect(schemaModels.get('DocumentChunk')).toBeDefined()
  })

  test('known models are all present (spot-check that the scan reached the end of the file)', () => {
    for (const name of ['Organization', 'Order', 'Invitation', 'SavedPrompt', 'DocumentChunk', 'LlmConfig']) {
      expect(schemaModels.has(name)).toBe(true)
    }
  })
})

// ---------------------------------------------------------------------------
// THE GUARD
// ---------------------------------------------------------------------------

describe('tenant scope coverage — every organizationId model is accounted for', () => {
  test('ORG_SCOPED_MODELS ∪ ORG_SCOPE_EXCEPTIONS EQUALS the schema-derived set', () => {
    // The load-bearing assertion. If a model is added to the schema with
    // `organizationId` and not to the extension's set, this fails and names it.
    expect(accountedForKeys).toEqual(schemaOrgScopedKeys)
  })

  test('NO organizationId model is silently unscoped — reports the missing model BY NAME', () => {
    // Same rule, but the failure message names the model and the fix, so a reader
    // who hits it does not have to derive which one is missing. Kept as a separate
    // assertion because `toEqual` on two arrays prints two long lists, and the
    // actionable part (the NAME) is what the next person needs.
    const missing = schemaOrgScopedKeys.filter(
      (key) => !ORG_SCOPED_MODELS.has(key) && !(key in ORG_SCOPE_EXCEPTIONS),
    )
    expect(
      missing,
      missing.length > 0
        ? `These models carry organizationId in prisma/schema.prisma but are absent from ` +
          `ORG_SCOPED_MODELS in src/lib/prisma-tenant.ts: ${missing.join(', ')}. ` +
          `Every Prisma operation on them is therefore UNSCOPED — a cross-tenant leak that ` +
          `neither invariants.test.ts (operation) nor tenant-route-guard.test.ts (route ritual) ` +
          `can detect. Add each to ORG_SCOPED_MODELS, or to ORG_SCOPE_EXCEPTIONS with its reason.`
        : 'ok',
    ).toEqual([])
  })

  test('there is no STALE entry in ORG_SCOPED_MODELS (a model that no longer exists or lost its column)', () => {
    // The other direction. A set naming a model that does not exist, or one that no
    // longer has organizationId, is dead config that reads as protection. This also
    // catches a model RENAMED in the schema without updating the set — which would
    // otherwise silently unscope it (the old name no longer matches, the new name
    // is missing).
    const stale = declaredScopedKeys.filter((key) => !schemaOrgScopedKeys.includes(key))
    expect(
      stale,
      stale.length > 0
        ? `These entries in ORG_SCOPED_MODELS match no organizationId-bearing model in ` +
          `prisma/schema.prisma: ${stale.join(', ')}. Either the model was renamed/removed ` +
          `(update the set) or it never had organizationId (remove the entry).`
        : 'ok',
    ).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// The exceptions are a security decision, so they are pinned individually
// ---------------------------------------------------------------------------

describe('ORG_SCOPE_EXCEPTIONS — each exclusion is explicit, justified, and minimal', () => {
  test('`invitation` is the ONLY exception, and it is justified', () => {
    // Pinning the COUNT (not just membership) means adding a second exception is a
    // deliberate edit to a line that states the consequence, rather than a quiet
    // addition to an object literal. An exception is a place isolation does not
    // happen automatically, so it must cost a test edit to add one.
    expect(exceptionKeys).toEqual(['invitation'])
  })

  test('the `invitation` reason records WHY (pre-auth, token is the credential)', () => {
    const reason = ORG_SCOPE_EXCEPTIONS.invitation ?? ''
    expect(reason.length).toBeGreaterThan(0)
    // The reason must name the mechanism, not just assert safety. If someone
    // rewrites this to "not needed", the next reader loses the only explanation of
    // why an organizationId-bearing model is exempt from organizationId filtering.
    expect(reason).toMatch(/pre-auth/i)
    expect(reason).toMatch(/token/i)
  })

  test('every exception has a non-empty reason', () => {
    for (const [model, reason] of Object.entries(ORG_SCOPE_EXCEPTIONS)) {
      expect(reason.trim().length, `${model} has an empty reason`).toBeGreaterThan(20)
    }
  })

  test('no model is BOTH scoped and excepted (the two sets are disjoint)', () => {
    // Overlap would mean the entry that calls itself an exception is not exceptional,
    // and the ambiguity would hide a real omission behind a "we already handled it".
    const overlap = declaredScopedKeys.filter((key) => key in ORG_SCOPE_EXCEPTIONS)
    expect(overlap).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// The specific regression, pinned by name
// ---------------------------------------------------------------------------

describe('regression: Order is org-scoped (the measured cross-tenant IDOR)', () => {
  test('`order` is in ORG_SCOPED_MODELS', () => {
    expect(ORG_SCOPED_MODELS.has('order')).toBe(true)
  })

  test('`Order` carries organizationId in the schema (so the assertion above is not vacuous)', () => {
    // If `Order` ever loses its organizationId column, the test above becomes
    // meaningless-but-green. This ties the two facts together so a schema change
    // cannot silently retire the regression guard.
    expect(schemaModels.get('Order')).toBe(true)
  })
})
