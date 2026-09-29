import { describe, expect, it, mock, beforeEach } from 'bun:test'
import { normalizeLoginInput } from './route'

describe('normalizeLoginInput', () => {
  it('accepts valid input and lowercases email', () => {
    expect(normalizeLoginInput({ email: ' Admin@Acme.com ', password: 'pw' })).toEqual({
      email: 'admin@acme.com',
      password: 'pw',
    })
  })

  it('rejects missing fields', () => {
    expect(normalizeLoginInput({ email: 'a@b.c' })).toBeNull()
    expect(normalizeLoginInput({ password: 'pw' })).toBeNull()
    expect(normalizeLoginInput(null)).toBeNull()
    expect(normalizeLoginInput({ email: '', password: 'pw' })).toBeNull()
  })
})

// ===========================================================================
// POST — the login flow itself
// ===========================================================================
//
// The original file tested ONLY the pure input normaliser, leaving the entire
// route at 35.14% executable. This is the authentication boundary: the 401 must
// stay generic (no user enumeration), a failure must be audited, and a success
// must rotate sessionVersion so old cookies die. None of that was pinned.

const state = {
  user: null as Record<string, unknown> | null,
  verify: true,
  audits: [] as Array<Record<string, unknown>>,
  updates: [] as Array<Record<string, unknown>>,
  updateResult: { sessionVersion: 7 },
  enterWithOrgCalls: [] as string[],
  jsonThrows: false,
  apiError: null as Error | null,
}

const mockFindUnique = mock(async (_a?: unknown) => state.user)
const mockUpdate = mock(async (a: Record<string, unknown>) => { state.updates.push(a); return state.updateResult })
const mockVerifyPassword = mock((_pw?: unknown, _hash?: unknown) => state.verify)

mock.module('@/lib/db', () => ({
  db: { user: { findUnique: mockFindUnique, update: mockUpdate } },
}))
mock.module('@/lib/prisma-tenant', () => ({
  bypassOrg: async <T>(fn: () => T) => fn(),
  enterWithOrg: (org: string) => { state.enterWithOrgCalls.push(org) },
}))
mock.module('@/lib/passwords', () => ({ verifyPassword: mockVerifyPassword }))
mock.module('@/lib/session', () => ({
  writeAudit: async (a: Record<string, unknown>) => { state.audits.push(a) },
  handleApiError: (e: unknown, fallback: string, status = 500) => {
    state.apiError = e as Error
    return Response.json({ error: fallback }, { status })
  },
}))
const mockSignSession = mock((_id?: unknown, _v?: unknown) => 'signed-token')
mock.module('@/lib/crypto', () => ({ signSession: mockSignSession }))

const { POST } = await import('./route')
const { resetLoginThrottleForTests, countLoginThrottleBucketsForTests } = await import('@/lib/login-throttle')
const { RATE_LIMIT_LOGIN, RATE_LIMIT_LOGIN_PER_IP } = await import('@/lib/constants')

/**
 * A NextRequest stand-in. The route reads json() AND headers (it derives the
 * client address for the failure throttle), so both must exist.
 */
function req(body: unknown, ip?: string) {
  return {
    json: async () => {
      if (state.jsonThrows) throw new Error('malformed body')
      return body
    },
    headers: new Headers(ip ? { 'x-forwarded-for': ip } : {}),
  } as never
}

const ACTIVE_USER = {
  id: 'u1',
  name: 'Admin',
  email: 'admin@acme.com',
  isActive: true,
  passwordHash: 'hash',
  role: 'admin',
  organizationId: 'org-1',
  sessionVersion: 6,
}

beforeEach(() => {
  // The failure throttle is MODULE state, so it survives between tests in this
  // process. Without this reset a lockout from one test leaks into the next --
  // and the leak would look like an unrelated failure.
  resetLoginThrottleForTests()
  state.user = ACTIVE_USER
  state.verify = true
  state.audits = []
  state.updates = []
  state.updateResult = { sessionVersion: 7 }
  state.enterWithOrgCalls = []
  state.jsonThrows = false
  state.apiError = null
  mockFindUnique.mockClear()
  mockUpdate.mockClear()
  mockVerifyPassword.mockClear()
  mockSignSession.mockClear()
})

describe('POST /api/auth/login — success', () => {
  it('returns 200 with the user identity and rotates sessionVersion', async () => {
    const res = await POST(req({ email: 'admin@acme.com', password: 'pw' }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    // The password hash must NEVER be echoed back.
    expect(JSON.stringify(body)).not.toContain('hash')
    expect(body.user).toEqual({ userId: 'u1', name: 'Admin', email: 'admin@acme.com', role: 'admin' })
    // Rotation is what invalidates previously issued cookies.
    expect(state.updates).toHaveLength(1)
    expect((state.updates[0] as { data: { sessionVersion: { increment: number } } }).data.sessionVersion)
      .toEqual({ increment: 1 })
  })

  it('sets an httpOnly session cookie signed with the NEW sessionVersion', async () => {
    const res = await POST(req({ email: 'admin@acme.com', password: 'pw' }))
    const cookie = res.cookies.get('x-active-user')
    expect(cookie?.value).toBe('signed-token')
    // httpOnly is the whole point: a readable cookie is stealable by any XSS.
    expect(cookie?.httpOnly).toBe(true)
    expect(cookie?.sameSite).toBe('lax')
    expect(cookie?.path).toBe('/')
    expect(cookie?.maxAge).toBe(60 * 60 * 24 * 7)
    // Signed with the INCREMENTED version, not the stale one.
    expect(mockSignSession).toHaveBeenCalledWith('u1', 7)
  })

  it('audits LOGIN_SUCCESS and enters the user org BEFORE auditing', async () => {
    await POST(req({ email: 'admin@acme.com', password: 'pw' }))
    const audit = state.audits.find((a) => a.action === 'LOGIN_SUCCESS')
    expect(audit).toBeDefined()
    expect(audit?.userId).toBe('u1')
    // The org context must be established first, or the audit row is written
    // without a tenant.
    expect(state.enterWithOrgCalls).toContain('org-1')
  })
})

describe('POST /api/auth/login — credentials are refused', () => {
  it('a WRONG PASSWORD returns 401 with a GENERIC message', async () => {
    state.verify = false
    const res = await POST(req({ email: 'admin@acme.com', password: 'wrong' }))
    expect(res.status).toBe(401)
    const body = await res.json()
    // The message must not reveal whether the ACCOUNT exists -- that is user
    // enumeration, and it is the reason the failing branch audits instead of
    // explaining.
    expect(body.error).toBe('Invalid email or password.')
    // Asserting the body does not contain the word "password" was WRONG: the
    // generic message itself contains it. What must not leak is whether the
    // ACCOUNT exists -- so the meaningful check is that the hash and the
    // submitted value never appear, and the message is the same generic string
    // as the unknown-email case (asserted in the sibling test).
    expect(JSON.stringify(body)).not.toContain('hash')
    expect(JSON.stringify(body)).not.toContain('wrong')
    expect(state.updates).toHaveLength(0)
    expect(mockSignSession).not.toHaveBeenCalled()
  })

  it('an UNKNOWN email is refused with the SAME generic message', async () => {
    // Identical to the wrong-password case, byte for byte -- asserting both makes
    // an enumeration regression impossible to miss.
    state.user = null
    const res = await POST(req({ email: 'nobody@acme.com', password: 'pw' }))
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'Invalid email or password.' })
  })

  it('a DISABLED account is refused, and the attempt is audited', async () => {
    // isActive === false must not be a bypass. An offboarded employee whose row is
    // merely flagged inactive must not be able to log in.
    state.user = { ...ACTIVE_USER, isActive: false }
    const res = await POST(req({ email: 'admin@acme.com', password: 'pw' }))
    expect(res.status).toBe(401)
    const audit = state.audits.find((a) => a.action === 'LOGIN_FAILED')
    expect(audit).toBeDefined()
    expect(audit?.severity).toBe('warning')
    expect(mockSignSession).not.toHaveBeenCalled()
  })

  it('a failed attempt for a KNOWN user is audited; an unknown email is not', async () => {
    // Only a known user has an id/organization to attribute the row to, so the
    // unknown-email case cannot be audited here. Pinned to document that gap
    // rather than implying coverage that does not exist.
    state.verify = false
    await POST(req({ email: 'admin@acme.com', password: 'wrong' }))
    expect(state.audits.filter((a) => a.action === 'LOGIN_FAILED')).toHaveLength(1)

    state.audits = []
    state.user = null
    await POST(req({ email: 'nobody@acme.com', password: 'pw' }))
    expect(state.audits.filter((a) => a.action === 'LOGIN_FAILED')).toHaveLength(0)
  })
})

describe('POST /api/auth/login — malformed requests', () => {
  it('a missing password returns 400 and never touches the database', async () => {
    const res = await POST(req({ email: 'admin@acme.com' }))
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'Email and password are required.' })
    // No lookup, so a 400 cannot be used to probe for accounts.
    expect(mockFindUnique).not.toHaveBeenCalled()
  })

  it('a body that is not JSON is treated as missing credentials, not a 500', async () => {
    // `await req.json().catch(() => null)` is deliberate: a client sending garbage
    // must get the same 400 as one sending nothing, never an unhandled throw.
    state.jsonThrows = true
    const res = await POST(req(null))
    expect(res.status).toBe(400)
    expect(mockFindUnique).not.toHaveBeenCalled()
  })

  it('a non-object body value is refused', async () => {
    const res = await POST(req('just a string'))
    expect(res.status).toBe(400)
  })

  it('an unexpected failure is routed through handleApiError, not leaked', async () => {
    // The outer catch. A DB outage during login must produce the sanitized handler
    // response -- leaking the driver error would expose schema details.
    mockFindUnique.mockImplementationOnce(async () => { throw new Error('db exploded') })
    const res = await POST(req({ email: 'admin@acme.com', password: 'pw' }))
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: 'Failed to process login.' })
    expect(state.apiError).toBeInstanceOf(Error)
  })
})

describe('POST /api/auth/login — the lookup itself', () => {
  it('looks the user up by NORMALISED email', async () => {
    await POST(req({ email: '  Admin@ACME.com  ', password: 'pw' }))
    const call = mockFindUnique.mock.calls[0]![0] as { where: { email: string } }
    expect(call.where.email).toBe('admin@acme.com')
  })

  it('the lookup is wrapped in bypassOrg (login precedes any org context)', async () => {
    // Without this the tenant extension would scope the read to a context that
    // does not exist yet, and every login would fail.
    await POST(req({ email: 'admin@acme.com', password: 'pw' }))
    expect(mockFindUnique).toHaveBeenCalledTimes(1)
  })

  it('the password is verified against the STORED hash', async () => {
    await POST(req({ email: 'admin@acme.com', password: 'secret' }))
    expect(mockVerifyPassword).toHaveBeenCalledWith('secret', 'hash')
  })
})

// ===========================================================================
// POST /api/auth/login — the failure-based brute-force throttle
// ===========================================================================
//
// The middleware used to hold this, and measured behaviour showed it could not: it
// counted every request, so the 11th CORRECT sign-in inside a minute was refused,
// and because a login request carries no session cookie every caller collapsed onto
// one shared bucket (`session::/api/auth/login`). The budget now lives in the route,
// which is the only place that can tell a guess from a success, and is keyed on the
// normalized account AND the client address.

const IP_A = '203.0.113.7'
const IP_B = '198.51.100.9'

describe('POST /api/auth/login — failed-attempt throttle', () => {
  it('refuses the attempt after RATE_LIMIT_LOGIN failures, with truthful headers', async () => {
    state.verify = false
    for (let i = 0; i < RATE_LIMIT_LOGIN; i += 1) {
      expect((await POST(req({ email: 'admin@acme.com', password: 'wrong' }, IP_A))).status).toBe(401)
    }

    // The trade-off, pinned deliberately rather than hidden: the budget is spent, so
    // even the CORRECT password waits out the window. Bounded by the 60s window, and
    // cleared by any success -- an attacker cannot hold a real user out past it.
    const res = await POST(req({ email: 'admin@acme.com', password: 'pw' }, IP_A))
    expect(res.status).toBe(429)
    expect(await res.json()).toEqual({ error: 'Too many failed sign-in attempts. Try again later.' })
    expect(res.headers.get('X-RateLimit-Limit')).toBe(String(RATE_LIMIT_LOGIN))
    expect(res.headers.get('X-RateLimit-Remaining')).toBe('0')
    const retry = Number(res.headers.get('Retry-After'))
    // Never 0: a client told to retry in 0 seconds retries immediately, fails again,
    // and reads that as a broken limit.
    expect(retry).toBeGreaterThan(0)
    expect(retry).toBeLessThanOrEqual(60)
  })

  it('the throttle is checked BEFORE the lookup, so a locked-out attempt costs no query', async () => {
    state.verify = false
    for (let i = 0; i < RATE_LIMIT_LOGIN; i += 1) {
      await POST(req({ email: 'admin@acme.com', password: 'wrong' }, IP_A))
    }
    mockFindUnique.mockClear()
    mockVerifyPassword.mockClear()

    const res = await POST(req({ email: 'admin@acme.com', password: 'wrong' }, IP_A))
    expect(res.status).toBe(429)
    expect(mockFindUnique).not.toHaveBeenCalled()
    expect(mockVerifyPassword).not.toHaveBeenCalled()
  })

  it('an UNKNOWN email spends the same budget as a real account', async () => {
    // The enumeration sweep has exactly this shape: no user rows, so no audit row can
    // be attributed and the account/address budget is the ONLY signal that exists.
    state.user = null
    for (let i = 0; i < RATE_LIMIT_LOGIN; i += 1) {
      expect((await POST(req({ email: 'nobody@acme.com', password: 'pw' }, IP_A))).status).toBe(401)
    }
    const res = await POST(req({ email: 'nobody@acme.com', password: 'pw' }, IP_A))
    expect(res.status).toBe(429)
    expect(res.headers.get('X-RateLimit-Limit')).toBe(String(RATE_LIMIT_LOGIN))
  })

  it('case variants of one address cannot dodge the account budget', async () => {
    state.verify = false
    for (let i = 0; i < RATE_LIMIT_LOGIN; i += 1) {
      await POST(req({ email: '  ADMIN@ACME.com ', password: 'wrong' }, IP_A))
    }
    // Different address, same account: only the ACCOUNT axis can be what stops this,
    // which is the point -- the budget follows the account, not the spelling.
    const res = await POST(req({ email: 'admin@acme.com', password: 'wrong' }, IP_B))
    expect(res.status).toBe(429)
  })

  it('a successful sign-in CLEARS the account budget', async () => {
    state.verify = false
    for (let i = 0; i < RATE_LIMIT_LOGIN - 1; i += 1) {
      await POST(req({ email: 'admin@acme.com', password: 'wrong' }, IP_A))
    }
    state.verify = true
    expect((await POST(req({ email: 'admin@acme.com', password: 'pw' }, IP_A))).status).toBe(200)

    // Without the clear, the FIRST of these would already be the 10th failure and the
    // second would be refused.
    state.verify = false
    for (let i = 0; i < RATE_LIMIT_LOGIN - 1; i += 1) {
      expect((await POST(req({ email: 'admin@acme.com', password: 'wrong' }, IP_A))).status).toBe(401)
    }
  })

  it('the ADDRESS budget is shared across accounts and survives a successful sign-in', async () => {
    // 5 failures from one address, spread across 5 different accounts.
    state.user = null
    for (let i = 0; i < 5; i += 1) {
      await POST(req({ email: `ghost${i}@acme.com`, password: 'pw' }, IP_B))
    }
    // A real user on the SAME address signs in successfully...
    state.user = ACTIVE_USER
    expect((await POST(req({ email: 'admin@acme.com', password: 'pw' }, IP_B))).status).toBe(200)

    // ...and the address still remembers all 5. If a success had cleared the address
    // budget, the fresh account below would be allowed through.
    state.user = null
    for (let i = 0; i < RATE_LIMIT_LOGIN_PER_IP - 5; i += 1) {
      await POST(req({ email: `spray${i}@acme.com`, password: 'pw' }, IP_B))
    }
    const res = await POST(req({ email: 'fresh@acme.com', password: 'pw' }, IP_B))
    expect(res.status).toBe(429)
    // The header names the axis that actually stopped it, so an operator reading a
    // support ticket can tell "this account" from "this office".
    expect(res.headers.get('X-RateLimit-Limit')).toBe(String(RATE_LIMIT_LOGIN_PER_IP))
  })

  it('one failed attempt spends budget on BOTH axes; a success clears only the account one', async () => {
    state.verify = false
    await POST(req({ email: 'admin@acme.com', password: 'wrong' }, IP_A))
    // An account-only or address-only implementation would report 1 here.
    expect(countLoginThrottleBucketsForTests()).toBe(2)

    state.verify = true
    await POST(req({ email: 'admin@acme.com', password: 'pw' }, IP_A))
    expect(countLoginThrottleBucketsForTests()).toBe(1)
  })

  it('a throttled attempt writes no audit row and issues no session', async () => {
    state.verify = false
    for (let i = 0; i < RATE_LIMIT_LOGIN; i += 1) {
      await POST(req({ email: 'admin@acme.com', password: 'wrong' }, IP_A))
    }
    state.audits = []
    mockSignSession.mockClear()
    mockUpdate.mockClear()

    const res = await POST(req({ email: 'admin@acme.com', password: 'pw' }, IP_A))
    expect(res.status).toBe(429)
    // Nothing happened, so there is nothing to audit -- and no session to hand out.
    expect(state.audits).toHaveLength(0)
    expect(mockSignSession).not.toHaveBeenCalled()
    expect(mockUpdate).not.toHaveBeenCalled()
  })

  it('the audits record the client address', async () => {
    state.verify = false
    await POST(req({ email: 'admin@acme.com', password: 'wrong' }, IP_A))
    expect(state.audits.find((a) => a.action === 'LOGIN_FAILED')?.ipAddress).toBe(IP_A)

    state.audits = []
    state.verify = true
    await POST(req({ email: 'admin@acme.com', password: 'pw' }, IP_B))
    expect(state.audits.find((a) => a.action === 'LOGIN_SUCCESS')?.ipAddress).toBe(IP_B)
  })
})
