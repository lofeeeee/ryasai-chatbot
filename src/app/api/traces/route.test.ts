/**
 * GET /api/traces and GET /api/traces/stats — the in-memory observability ring buffer's HTTP face.
 *
 * WHY THIS FILE EXISTS. These handlers are the ONLY way the ring buffer reaches a browser, so they carry both
 * halves of the fix for a VERIFIED cross-tenant leak — every one of them is pinned here:
 *
 *   1. ADMIN ONLY. Neither route had a role check, so any authenticated viewer/analyst of any tenant could read
 *      every org's prompt bodies and answers. `requireRole(user, 'admin')` is asserted on the CALL and on the
 *      OBSERVABLE 403, because a guard asserted only by its presence in the source is a guard that cannot fail.
 *   2. THE ORG ARGUMENT. `enterWithOrg` only writes AsyncLocalStorage; the buffer is a module global, not a Prisma
 *      query, so the tenant extension cannot scope it. Each route must PASS its org to the reader. Asserted on the
 *      ARGUMENT the reader receives, since the return value is mocked here and would prove nothing about scoping
 *      (the real end-to-end proof, with the real reader, lives in observability-org-scope.test.ts).
 *
 * The LIMIT CLAMP is also pinned, which is arithmetic on untrusted query input with two tempting wrong answers:
 *
 *   - `Number(null)` is 0 and `Math.max(0, 1)` is 1, so a MISSING `limit` silently becomes 1 rather than the
 *     documented default of 50. The route avoids that by defaulting the STRING to '50' before coercion.
 *   - `Number('abc')` is NaN, and `Math.min(Math.max(NaN, 1), 100)` is NaN -- which would reach the ring buffer as
 *     a slice bound. NaN there behaves like 0, so a typo'd limit returns an EMPTY list instead of an error.
 *
 * A negative limit clamps to 1 (not 0, and not "from the end"), and an over-large one clamps to 100. The CLAMPED
 * value is what the buffer receives -- asserted on the ARGUMENT, because asserting on the returned array would
 * pass for any limit above the fixture size and prove nothing.
 *
 * Also pinned: the envelopes are `{traces}` / `{stats}` rather than a shared `data` key.
 */
import { describe, expect, test, beforeEach, mock } from 'bun:test'

interface TestUser {
  userId: string
  name: string
  email: string
  role: string
  organizationId: string
  plan: string
}

// The admin persona is the one the routes now admit; the analyst/default persona below exists to prove the refusal.
const adminUser: TestUser = {
  userId: 'u0',
  name: 'Root',
  email: 'root@t.com',
  role: 'admin',
  organizationId: 'org-1',
  plan: 'pro',
}

const analystUser: TestUser = {
  userId: 'u1',
  name: 'Ada',
  email: 'a@t.com',
  role: 'analyst',
  organizationId: 'org-1',
  plan: 'pro',
}

// ---- mutable seams, declared before every mock.module ----
let user: TestUser = adminUser
let traceRows: unknown[] = [{ id: 't1' }]
let statsPayload: Record<string, unknown> = { total: 3, errors: 0 }
let tracesThrow: Error | null = null
const events: string[] = []
const limitArgs: number[] = []
// The org each reader was HANDED. Collected per function so a route that reads the buffer without passing its org
// is caught even though the mocked reader returns a fixture either way.
const tracesOrgArgs: Array<string | undefined> = []
const statsOrgArgs: Array<string | undefined> = []

mock.module('@/lib/session', () => ({
  getActiveUser: async () => user,
  // Mirrors the real requireRole: rank-based, and it THROWS a ForbiddenError. The mock must be able to fail, or
  // the 403 tests below would pass for a route that never calls it.
  requireRole: (u: { role: string }, minRole: 'admin' | 'analyst' | 'viewer') => {
    events.push(`requireRole:${minRole}`)
    const rank: Record<string, number> = { viewer: 0, analyst: 1, admin: 2 }
    if ((rank[u.role] ?? 0) < (rank[minRole] ?? 0)) {
      throw Object.assign(new Error(`Requires ${minRole} role. You have ${u.role}.`), {
        name: 'ForbiddenError',
        code: 'FORBIDDEN',
      })
    }
  },
  // Mirrors how the REAL mapper branches: on the error CLASS, not the fallback. That is what makes "a refused
  // analyst is 403, not 500" a real assertion rather than a restatement of the fallback.
  handleApiError: (e: unknown, fallback: string, status = 500) => {
    if ((e as { name?: string } | null)?.name === 'ForbiddenError') {
      return Response.json(
        { ok: false, error: { code: 'FORBIDDEN', message: (e as Error).message } },
        { status: 403 },
      )
    }
    return Response.json({ ok: false, error: { code: 'INTERNAL_ERROR', message: fallback } }, { status })
  },
}))

mock.module('@/lib/prisma-tenant', () => ({
  enterWithOrg: (o: string) => {
    events.push(`enterWithOrg:${o}`)
  },
}))

mock.module('@/lib/observability', () => ({
  getRecentTraces: (limit: number, organizationId?: string) => {
    limitArgs.push(limit)
    tracesOrgArgs.push(organizationId)
    if (tracesThrow) throw tracesThrow
    return traceRows
  },
  getTraceStats: (organizationId?: string) => {
    statsOrgArgs.push(organizationId)
    return statsPayload
  },
}))

// DYNAMIC: a static import would be evaluated before the mocks above and bypass every one of them.
const tracesRoute = await import('./route')
const statsRoute = await import('./stats/route')

function get(query = '', which: 'traces' | 'stats' = 'traces') {
  const base = which === 'traces' ? '/api/traces' : '/api/traces/stats'
  const url = `http://localhost${base}${query}`
  const req = new Request(url) as Request & { nextUrl: URL }
  req.nextUrl = new URL(url)
  return which === 'traces' ? tracesRoute.GET(req as never) : statsRoute.GET()
}

beforeEach(() => {
  // ADMIN by default: the routes are admin-gated now, so the clamp/envelope suites below exercise the admitted
  // path. The refusal itself is pinned in its own describe block, which sets the other roles explicitly.
  user = adminUser
  traceRows = [{ id: 't1' }]
  statsPayload = { total: 3, errors: 0 }
  tracesThrow = null
  events.length = 0
  limitArgs.length = 0
  tracesOrgArgs.length = 0
  statsOrgArgs.length = 0
})

describe('/api/traces — the limit clamp', () => {
  test('an OMITTED limit is 50, NOT 1 (Number(null) would be 0)', async () => {
    // The route defaults the STRING to '50' before coercing; defaulting the NUMBER would make Math.max(0, 1) = 1.
    await get('')
    expect(limitArgs).toEqual([50])
  })

  test('an explicit limit is passed through', async () => {
    await get('?limit=7')
    expect(limitArgs).toEqual([7])
  })

  test('an over-large limit clamps to 100', async () => {
    await get('?limit=5000')
    expect(limitArgs).toEqual([100])
  })

  test('a limit of exactly 100 is allowed', async () => {
    await get('?limit=100')
    expect(limitArgs).toEqual([100])
  })

  test('a limit of exactly 1 is allowed', async () => {
    await get('?limit=1')
    expect(limitArgs).toEqual([1])
  })

  test('ZERO clamps UP to 1, not down to 0', async () => {
    // A zero limit would return an empty list while looking like a successful request.
    await get('?limit=0')
    expect(limitArgs).toEqual([1])
  })

  test('a NEGATIVE limit clamps to 1, not "from the end"', async () => {
    await get('?limit=-20')
    expect(limitArgs).toEqual([1])
  })

  test('a NON-NUMERIC limit yields NaN, which the buffer treats as 0 — recorded as the current behaviour', async () => {
    // `Math.min(Math.max(NaN, 1), 100)` is NaN. The clamp does NOT catch a typo, and NaN is what the ring buffer
    // receives. Pinned so a future fix (e.g. `|| 50` before the clamp) turns this test red deliberately.
    await get('?limit=abc')
    expect(limitArgs).toHaveLength(1)
    expect(Number.isNaN(limitArgs[0]!)).toBe(true)
  })

  test('a FRACTIONAL limit is passed through un-rounded', async () => {
    // Same family as NaN: nothing normalises the value, so 2.5 reaches the buffer and `slice(0, 2.5)` is 2.
    await get('?limit=2.5')
    expect(limitArgs).toEqual([2.5])
  })

  test('an EMPTY limit is coerced to 0 and then clamped to 1', async () => {
    // `?? '50'` does NOT fire for an empty string (it is not nullish), so `Number('')` is 0.
    await get('?limit=')
    expect(limitArgs).toEqual([1])
  })
})

describe('/api/traces — envelope and context', () => {
  test('it answers {ok, traces}', async () => {
    traceRows = [{ id: 'a' }, { id: 'b' }]
    const body = (await (await get('?limit=2')).json()) as Record<string, unknown>
    expect(body).toEqual({ ok: true, traces: [{ id: 'a' }, { id: 'b' }] })
  })

  test('an empty buffer is 200 with an empty array', async () => {
    traceRows = []
    const body = (await (await get('')).json()) as { traces: unknown[] }
    expect(body.traces).toEqual([])
  })

  test('it enters the session org context, then gates on the role', async () => {
    await get('')
    // ORDER matters and is pinned: the org context is entered BEFORE the role check, so a refused caller is
    // refused by a check that had the org available (and so the refusal cannot hide an unscoped read).
    expect(events).toEqual(['enterWithOrg:org-1', 'requireRole:admin'])
  })

  test('a buffer read failure is 500 without leaking the error text', async () => {
    tracesThrow = new Error('ring buffer corrupted')
    const res = await get('')
    expect(res.status).toBe(500)
    expect(await res.text()).not.toContain('ring buffer corrupted')
  })
})

describe('/api/traces — admin gate (a viewer/analyst must not read any tenant\'s prompts)', () => {
  // THE VERIFIED DEFECT: neither route had a role check, so any authenticated user of any tenant could read every
  // org's prompt bodies and answers. These tests fail if requireRole is deleted OR merely moved below the read.
  test('an ANALYST is refused with 403 FORBIDDEN', async () => {
    user = analystUser
    const res = await get('')
    expect(res.status).toBe(403)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('FORBIDDEN')
  })

  test('a VIEWER is refused with 403 FORBIDDEN', async () => {
    user = { ...analystUser, role: 'viewer' }
    const res = await get('')
    expect(res.status).toBe(403)
  })

  test('the refusal happens BEFORE the buffer is read — a refused caller gets no rows and no clamp', async () => {
    user = analystUser
    await get('?limit=7')
    expect(limitArgs).toHaveLength(0)
    expect(tracesOrgArgs).toHaveLength(0)
  })

  test('an ADMIN is admitted and receives the rows', async () => {
    const res = await get('')
    expect(res.status).toBe(200)
  })

  test('/stats carries the SAME gate — an analyst is refused there too', async () => {
    user = analystUser
    const res = await get('', 'stats')
    expect(res.status).toBe(403)
    expect(statsOrgArgs).toHaveLength(0)
  })

  test('the gate asks for the literal admin role', async () => {
    await get('')
    expect(events).toContain('requireRole:admin')
  })
})

describe('/api/traces — the org is PASSED to the reader (enterWithOrg alone does not scope memory)', () => {
  // The trap: `enterWithOrg` writes AsyncLocalStorage, and the tenant extension — not the buffer — is what turns
  // that into a `where organizationId`. The buffer is a module global, so each route MUST hand the reader its org.
  test('/traces passes the session org, not undefined', async () => {
    await get('')
    expect(tracesOrgArgs).toEqual(['org-1'])
  })

  test('/stats passes the session org, not undefined', async () => {
    await get('', 'stats')
    expect(statsOrgArgs).toEqual(['org-1'])
  })

  test('the org passed is the SESSION\'S, followed to a second org rather than a constant', async () => {
    user = { ...adminUser, organizationId: 'org-2' }
    await get('')
    expect(tracesOrgArgs).toEqual(['org-2'])
    expect(events).toEqual(['enterWithOrg:org-2', 'requireRole:admin'])
  })
})

describe('/api/traces/stats', () => {
  test('it answers {ok, stats}', async () => {
    statsPayload = { total: 9, errors: 2, p95Ms: 120 }
    const body = (await (await get('', 'stats')).json()) as Record<string, unknown>
    expect(body).toEqual({ ok: true, stats: { total: 9, errors: 2, p95Ms: 120 } })
  })

  test('it takes NO query parameters (no clamping to pin)', async () => {
    // Explicitly recorded: /stats reports the WHOLE of THIS ORG's buffer (the org filter is the reader's, passed
    // below), so a caller cannot narrow it here. The handler takes no argument at all, which is why the call site
    // passes none.
    const res = await get('?limit=1', 'stats')
    const body = (await res.json()) as { stats: unknown }
    expect(body.stats).toEqual(statsPayload)
    expect(limitArgs).toHaveLength(0)
  })

  test('it enters the session org context, then gates on the role', async () => {
    await get('', 'stats')
    expect(events).toEqual(['enterWithOrg:org-1', 'requireRole:admin'])
  })

  test('empty stats are a success, not an error', async () => {
    statsPayload = {}
    const body = (await (await get('', 'stats')).json()) as { ok: boolean; stats: unknown }
    expect(body.ok).toBe(true)
    expect(body.stats).toEqual({})
  })
})
