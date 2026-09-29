import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { verifyPassword } from '@/lib/passwords'
import { signSession } from '@/lib/crypto'
import { writeAudit, handleApiError } from '@/lib/session'
import { bypassOrg, enterWithOrg } from '@/lib/prisma-tenant'
import { getClientIp } from '@/lib/client-ip'
import { checkLoginThrottle, clearLoginFailures, recordLoginFailure } from '@/lib/login-throttle'

/**
 * POST /api/auth/login
 *   Body: { email, password }
 *   - 200 { ok: true, user: { userId, name, email, role } } + httpOnly
 *     `x-active-user` cookie (7-day HMAC-signed session).
 *   - 400 when email/password missing.
 *   - 401 with a GENERIC message on bad credentials (no user enumeration).
 *   - 429 when this account, or this client address, has spent its FAILED-attempt budget for the window.
 *
 * The brute-force guard counts FAILURES ONLY, per normalized account and per client address, and lives here
 * rather than in the middleware because only the route can see whether an attempt succeeded. The middleware
 * counter this replaced counted every request -- it refused the 11th CORRECT sign-in inside a minute -- and,
 * because a login request carries no session cookie, keyed every anonymous caller on one shared bucket.
 */
export function normalizeLoginInput(body: unknown): { email: string; password: string } | null {
  if (!body || typeof body !== 'object') return null
  const b = body as Record<string, unknown>
  const email = typeof b.email === 'string' ? b.email.trim().toLowerCase() : ''
  const password = typeof b.password === 'string' ? b.password : ''
  if (!email || !password) return null
  return { email, password }
}

export async function POST(req: NextRequest) {
  try {
    const input = normalizeLoginInput(await req.json().catch(() => null))
    if (!input) {
      return NextResponse.json(
        { error: 'Email and password are required.' },
        { status: 400 },
      )
    }

    const ip = getClientIp(req)

    // Checked BEFORE the lookup: a locked-out attempt must not cost a database round trip, and the budget
    // must not depend on the account existing -- an enumeration sweep produces no account rows at all.
    const verdict = checkLoginThrottle(input.email, ip)
    if (verdict.limited) {
      return NextResponse.json(
        { error: 'Too many failed sign-in attempts. Try again later.' },
        {
          status: 429,
          headers: {
            'Retry-After': String(verdict.retryAfterSeconds),
            'X-RateLimit-Limit': String(verdict.limit),
            'X-RateLimit-Remaining': '0',
          },
        },
      )
    }

    // ponytail: login runs before org context exists — bypassOrg for user lookup.
    // findUnique is not scoped by the tenant extension (can't add non-unique fields).
    const user = await bypassOrg(() =>
      db.user.findUnique({
        where: { email: input.email },
        select: { id: true, name: true, email: true, isActive: true, passwordHash: true, role: true, organizationId: true, sessionVersion: true },
      }),
    )
    const ok = !!user && user.isActive && verifyPassword(input.password, user.passwordHash)
    if (!user || !ok) {
      // Every failed verification spends the budget, INCLUDING an unknown email -- that is the only signal
      // an enumeration sweep produces, because those attempts have no user row to attribute an audit to.
      recordLoginFailure(input.email, ip)
      if (user) {
        enterWithOrg(user.organizationId)
        await writeAudit({
          userId: user.id,
          action: 'LOGIN_FAILED',
          severity: 'warning',
          detail: { email: input.email },
          ipAddress: ip,
        })
      }
      return NextResponse.json({ error: 'Invalid email or password.' }, { status: 401 })
    }

    // A success clears the ACCOUNT budget: a real user must not spend the rest of the window locked out by
    // someone else's guessing. The ADDRESS budget deliberately survives a success (see login-throttle.ts).
    clearLoginFailures(input.email)

    // Set org context for writeAudit + session increment
    enterWithOrg(user.organizationId)
    await writeAudit({
      userId: user.id,
      action: 'LOGIN_SUCCESS',
      detail: { email: user.email },
      ipAddress: ip,
    })

    const updated = await db.user.update({
      where: { id: user.id },
      data: { sessionVersion: { increment: 1 } },
      select: { sessionVersion: true },
    })

    const res = NextResponse.json({
      ok: true,
      user: { userId: user.id, name: user.name, email: user.email, role: user.role },
    })
    res.cookies.set('x-active-user', signSession(user.id, updated.sessionVersion), {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      maxAge: 60 * 60 * 24 * 7,
      path: '/',
    })
    return res
  } catch (e) {
    return handleApiError(e, 'Failed to process login.')
  }
}
