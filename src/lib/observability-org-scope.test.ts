/**
 * THE CROSS-TENANT LEAK GUARD — real ring buffer, real reader, real routes, real `requireRole`.
 *
 * WHY THIS FILE IS SEPARATE from observability.test.ts and traces/route.test.ts. Both of those mock the seam that
 * is broken:
 *
 *   - observability.test.ts exercises the buffer directly, so it can only see the buffer.
 *   - traces/route.test.ts mocks `@/lib/observability`, so its "the org is passed" assertion proves the route
 *     passes an argument — NOT that passing it scopes anything. A reader that ignored its org argument entirely
 *     would leave that file green.
 *
 * The VERIFIED DEFECT lived exactly in the gap between those two: `enterWithOrg(...)` was called (so the static
 * tenant-route-guard passed) and then ignored, because the buffer is a module global rather than a Prisma query
 * and the tenant extension cannot see it. Any authenticated user of any tenant could read every tenant's prompt
 * bodies and answers. So this file mocks NOTHING: it imports the real reader, the real `requireRole`, and drives
 * the real route handlers with two orgs alive in one process.
 *
 * The negative control for this file is "make the reader ignore its org argument and return the whole buffer",
 * which is the original defect — see the FAILING transition recorded in the report.
 */
import { describe, expect, test, mock } from 'bun:test'
import { enterWithOrg } from '@/lib/prisma-tenant'
// The REAL session module, imported under a binding so its parts can be reused below. `requireRole` and
// `handleApiError` are the shipped implementations — a mocked 403 would prove nothing about the shipped gate.
import * as sessionActual from '@/lib/session'

// ---- the two tenants, both live in ONE process: the whole point is that they share a buffer ----
const ORG_A = 'org-alpha'
const ORG_B = 'org-beta'

const SECRET_A = 'ALPHA-CUSTOMER-PROMPT-DO-NOT-LEAK'
const SECRET_B = 'BETA-CUSTOMER-PROMPT-DO-NOT-LEAK'

const ROUTE_ADMIN_A = {
  userId: 'u-a',
  name: 'Admin A',
  email: 'a@t.com',
  role: 'admin',
  organizationId: ORG_A,
  plan: 'pro',
}

/**
 * The session seam the route needs, and ONLY that seam: `getActiveUser` needs a cookie there is none of in a unit
 * test. `requireRole` and `handleApiError` are deliberately NOT replaced — they are spread from the REAL module, so
 * the 403 below is produced by the shipped rank check and the shipped error mapping rather than by a stub. (A
 * partial mock here does not fail gracefully: the route's named imports of the missing exports throw at link time,
 * which is the bun:test mock.module trap recorded in AGENTS.md.)
 */
let httpUser: { role: string; organizationId: string } = ROUTE_ADMIN_A
mock.module('@/lib/session', () => ({
  ...sessionActual,
  getActiveUser: async () => httpUser,
}))

const tracesRoute = await import('../app/api/traces/route')

function request(query = '') {
  const url = `http://localhost/api/traces${query}`
  const req = new Request(url) as Request & { nextUrl: URL }
  req.nextUrl = new URL(url)
  return tracesRoute.GET(req as never)
}

/**
 * The real module, imported WITHOUT a mock. A static import is what makes this an integration of the shipped code
 * rather than a restatement of a stub. `getOrgContext` is imported from the real prisma-tenant as well.
 */
const {
  traceLlmCall,
  getRecentTraces,
  getTraceStats,
  NO_ORG_TRACE_SCOPE,
} = await import('@/lib/observability')

/** Record one trace as `organizationId`, with a purpose unique to the call so a leak is identifiable. */
function recordAs(organizationId: string | undefined, purpose: string, inputPreview = '') {
  return enterFor(organizationId, () =>
    traceLlmCall({
      purpose,
      provider: 'x',
      model: 'm',
      inputPreview,
      outputPreview: '',
      latencyMs: 1,
    }),
  )
}

/** Run `fn` with `organizationId` as the ambient context (undefined = no org context at all). */
function enterFor<T>(organizationId: string | undefined, fn: () => T): T {
  if (organizationId === undefined) return fn()
  enterWithOrg(organizationId)
  return fn()
}

const uniq = (label: string) => `${label}-${Date.now()}-${Math.random()}`

// NO `beforeEach` enters an org here, and that is deliberate: measured on Bun 1.4.2, a context entered in a
// `beforeEach` does NOT propagate to the test body, so it would look like setup while leaving every test with NO
// org context — where several assertions below would pass for the wrong reason. Each test enters its own context
// (or none, on purpose). Module-level `enterWithOrg` is also unusable here: it leaks into the runner's own frames
// and makes bun:test report timeouts instead of results.

describe('the ring buffer is per-org (REAL reader, two orgs in one process)', () => {
  test('a trace recorded by org A is returned to org A', () => {
    const purpose = uniq('a-only')
    recordAs(ORG_A, purpose, SECRET_A)
    const mine = enterFor(ORG_A, () => getRecentTraces(100))
    expect(mine.some((t) => t.purpose === purpose)).toBe(true)
  })

  test('THE LEAK: org B reading the buffer does not receive org A\'s trace', () => {
    const purpose = uniq('a-secret')
    recordAs(ORG_A, purpose, SECRET_A)

    const theirs = enterFor(ORG_B, () => getRecentTraces(100))
    expect(theirs.some((t) => t.purpose === purpose)).toBe(false)
    // The payload itself, not just the id: this is the assertion that fails if the reader returns the whole buffer.
    expect(JSON.stringify(theirs)).not.toContain(SECRET_A)
  })

  test('and the reverse holds — org A does not receive org B\'s trace', () => {
    const purpose = uniq('b-secret')
    recordAs(ORG_B, purpose, SECRET_B)

    const mine = enterFor(ORG_A, () => getRecentTraces(100))
    expect(mine.some((t) => t.purpose === purpose)).toBe(false)
    expect(JSON.stringify(mine)).not.toContain(SECRET_B)
  })

  test('an explicit org argument scopes the read on its own, without the ambient context', () => {
    const purpose = uniq('explicit')
    recordAs(ORG_A, purpose, SECRET_A)
    // No enterWithOrg: the ARGUMENT is the only thing identifying the reader.
    const recent = getRecentTraces(100, ORG_A)
    expect(recent.some((t) => t.purpose === purpose)).toBe(true)
    expect(JSON.stringify(recent)).not.toContain(SECRET_B)
  })

  test('every returned trace carries the org that recorded it', () => {
    recordAs(ORG_A, uniq('stamped-a'))
    const [first] = enterFor(ORG_A, () => getRecentTraces(1))
    expect(first?.organizationId).toBe(ORG_A)
  })

  test('the org is stamped from the CONTEXT, so a caller cannot label an org-A trace as org B', () => {
    // The type omits `organizationId`, so this is the runtime belt to the compile-time braces: even a caller that
    // smuggles the field in through a cast cannot make the trace readable by the other org.
    const purpose = uniq('smuggled')
    enterFor(ORG_A, () =>
      traceLlmCall({
        purpose,
        provider: 'x',
        model: 'm',
        inputPreview: SECRET_A,
        outputPreview: '',
        latencyMs: 1,
        ...({ organizationId: ORG_B } as Record<string, unknown>),
      } as never),
    )
    const seenByB = enterFor(ORG_B, () => getRecentTraces(100))
    expect(seenByB.some((t) => t.purpose === purpose)).toBe(false)
    const seenByA = enterFor(ORG_A, () => getRecentTraces(100))
    expect(seenByA.some((t) => t.purpose === purpose)).toBe(true)
  })
})

describe('the no-org sentinel can NEVER be returned to a tenant', () => {
  test('a trace recorded with NO org context is not retrievable by any org', () => {
    const purpose = uniq('no-org')
    // A secret used by NO org anywhere in this file. Reusing SECRET_A here was a MEASURED false failure: ORG_A's
    // own earlier traces legitimately carry it, so "org A cannot see SECRET_A" was confounded by the fixtures
    // rather than by the code. The payload must be unique to the trace whose reachability is in question.
    const NO_ORG_SECRET = 'NO-ORG-CONTEXT-PAYLOAD-DO-NOT-LEAK'
    // No enterWithOrg at all — the background-worker / test shape.
    traceLlmCall({
      purpose,
      provider: 'x',
      model: 'm',
      inputPreview: NO_ORG_SECRET,
      outputPreview: '',
      latencyMs: 1,
    })

    for (const org of [ORG_A, ORG_B]) {
      const theirs = enterFor(org, () => getRecentTraces(100))
      expect(theirs.some((t) => t.purpose === purpose)).toBe(false)
      expect(JSON.stringify(theirs)).not.toContain(NO_ORG_SECRET)
    }
  })

  test('it is recorded rather than dropped, and stamped with the sentinel', () => {
    // The decision this pins: recording is kept (the no-org calls are the ones an operator most needs to see),
    // and the risk is answered by the FILTER, not by refusing to record.
    const purpose = uniq('no-org-kept')
    traceLlmCall({
      purpose,
      provider: 'x',
      model: 'm',
      inputPreview: '',
      outputPreview: '',
      latencyMs: 1,
    })
    const mine = getRecentTraces(100, NO_ORG_TRACE_SCOPE)
    expect(mine.some((t) => t.purpose === purpose)).toBe(true)
    expect(mine.every((t) => t.organizationId === NO_ORG_TRACE_SCOPE)).toBe(true)
  })

  test('the sentinel is not a value an org id can equal, so no org can reach it by accident', () => {
    // An `Organization.id` is a cuid; the sentinel is deliberately not cuid-shaped, so even a hypothetical org
    // whose id was attacker-chosen cannot collide with the org-less bucket.
    expect(NO_ORG_TRACE_SCOPE).not.toMatch(/^c[a-z0-9]{20,}$/)
    expect(NO_ORG_TRACE_SCOPE.length).toBeGreaterThan(0)
  })
})

describe('getTraceStats is scoped too (the aggregate is not harmless)', () => {
  test('an org\'s totals count only its own traces', () => {
    const purpose = uniq('stats-a')
    recordAs(ORG_A, purpose)
    const before = enterFor(ORG_B, () => getTraceStats())
    recordAs(ORG_A, uniq('stats-a2'))
    const after = enterFor(ORG_B, () => getTraceStats())
    // Org B recorded nothing, so ITS totals must not move when org A records.
    expect(after.totalCalls).toBe(before.totalCalls)
  })

  test('the recording org\'s totals DO move, so the scope is not simply returning zeroes', () => {
    // The counterweight without which the test above would pass for a reader that always returns zeroes.
    const before = enterFor(ORG_A, () => getTraceStats())
    recordAs(ORG_A, uniq('stats-a3'))
    const after = enterFor(ORG_A, () => getTraceStats())
    expect(after.totalCalls).toBe(before.totalCalls + 1)
  })

  test('the numbers are org B\'s OWN, not a prefix or a total of everyone\'s', () => {
    recordAs(ORG_A, uniq('stats-a4'))
    const bBefore = enterFor(ORG_B, () => getTraceStats())
    const aBefore = enterFor(ORG_A, () => getTraceStats())
    expect(aBefore.totalCalls).toBeGreaterThanOrEqual(bBefore.totalCalls)
    // Stats for A exclude B's traces entirely: adding a B trace must not change A's count.
    recordAs(ORG_B, uniq('stats-b'))
    expect(enterFor(ORG_A, () => getTraceStats()).totalCalls).toBe(aBefore.totalCalls)
  })
})

describe('an explicit org that CONTRADICTS the context is refused, not honoured', () => {
  test('ambient org A + argument org B returns NOTHING (fail closed)', () => {
    // This is the client-supplied-org-id shape: the only way the two can disagree is code trusting an org it did
    // not derive from the session. The answer is an empty result, which is indistinguishable from "this org has
    // no traces" — so the caller learns nothing about the other org.
    const purpose = uniq('contradiction')
    recordAs(ORG_B, purpose, SECRET_B)
    const result = enterFor(ORG_A, () => getRecentTraces(100, ORG_B))
    expect(result).toEqual([])
    expect(JSON.stringify(result)).not.toContain(SECRET_B)
  })

  test('the same disagreement zeroes the stats rather than exposing the other org\'s numbers', () => {
    recordAs(ORG_B, uniq('contradiction-stats'))
    const stats = enterFor(ORG_A, () => getTraceStats(ORG_B))
    expect(stats).toEqual({ totalCalls: 0, avgLatencyMs: 0, errorRate: 0, totalTokens: 0 })
  })

  test('an AGREEING explicit org is honoured normally (so the refusal is not blanket)', () => {
    const purpose = uniq('agree')
    recordAs(ORG_A, purpose)
    const bothWays = enterFor(ORG_A, () => getRecentTraces(100, ORG_A))
    expect(bothWays.some((t) => t.purpose === purpose)).toBe(true)
  })
})

describe('the ROUTES, with the real requireRole and the real reader', () => {
  test('admin of org A cannot see org B\'s prompt body THROUGH THE HTTP RESPONSE', async () => {
    const purpose = uniq('http-b-secret')
    recordAs(ORG_B, purpose, SECRET_B)
    recordAs(ORG_A, uniq('http-a'), SECRET_A)

    httpUser = ROUTE_ADMIN_A
    const res = await request('?limit=100')
    expect(res.status).toBe(200)
    const raw = await res.text()
    // Asserted on the BODY, not on the query: the whole defect was that the body carried another tenant's data.
    expect(raw).not.toContain(SECRET_B)
    expect(raw).toContain(SECRET_A)
  })

  test('a non-admin is refused with 403 by the REAL requireRole', async () => {
    httpUser = { ...ROUTE_ADMIN_A, role: 'analyst' }
    const res = await request('')
    expect(res.status).toBe(403)
    const body = (await res.json()) as { error?: { code?: string } }
    expect(body.error?.code).toBe('FORBIDDEN')
  })

  test('a VIEWER is refused too, and the refusal body carries no trace payload', async () => {
    recordAs(ORG_A, uniq('viewer-probe'), SECRET_A)
    httpUser = { ...ROUTE_ADMIN_A, role: 'viewer' }
    const res = await request('?limit=100')
    expect(res.status).toBe(403)
    expect(await res.text()).not.toContain(SECRET_A)
  })
})
