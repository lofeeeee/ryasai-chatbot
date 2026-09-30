import { NextResponse } from 'next/server'
import { getActiveUser, handleApiError, requireRole } from '@/lib/session'
import { getTraceStats } from '@/lib/observability'
import { enterWithOrg } from '@/lib/prisma-tenant'

/**
 * GET /api/traces/stats → { ok, stats } — aggregate counts for THIS org's traces.
 *
 * Same two defects as `/api/traces`, same fixes. THE TRAP: `enterWithOrg` alone is NOT
 * scoping when the data is in-process memory rather than a Prisma query — the org
 * context it writes is consumed by the Prisma tenant extension, and the trace buffer
 * is a module global the extension never sees. So this handler faithfully entered the
 * org, then asked the shared buffer for totals that covered every tenant.
 *
 * `user.organizationId` is passed explicitly so the read does not depend on the
 * ambient context surviving the call above.
 */
export async function GET() {
  try {
    const user = await getActiveUser()

    enterWithOrg(user.organizationId)

    // ADMIN ONLY — an aggregate is not harmless: call volume and error rate per
    // purpose still describe another tenant's traffic, and it is the same buffer.
    requireRole(user, 'admin')

    return NextResponse.json({ ok: true, stats: getTraceStats(user.organizationId) })
  } catch (e) {
    return handleApiError(e, 'Failed to load trace stats.')
  }
}
