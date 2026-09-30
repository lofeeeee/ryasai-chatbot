import { NextRequest, NextResponse } from 'next/server'
import { getActiveUser, handleApiError, requireRole } from '@/lib/session'
import { getRecentTraces } from '@/lib/observability'
import { enterWithOrg } from '@/lib/prisma-tenant'

/**
 * GET /api/traces → { ok, traces } — the in-memory observability ring buffer.
 *
 * ADMIN ONLY, and the org argument below is LOAD-BEARING — both were missing.
 *
 * THE TRAP: `enterWithOrg` alone is NOT scoping when the data is in-process memory
 * rather than a Prisma query. `enterWithOrg` only writes AsyncLocalStorage, and it is
 * the tenant EXTENSION that turns that context into a `where organizationId`. The
 * trace buffer is a module global, so no extension can see it: this handler entered
 * the org, read the whole buffer, and `tenant-route-guard.test.ts` — which checks for
 * the `enterWithOrg` CALL — passed it while any authenticated user of any org could
 * read every tenant's prompt bodies and answers. The reader must be handed the org.
 *
 * `user.organizationId` (the session's org) is passed explicitly rather than relying
 * on the ambient context, so this route stays scoped even if the `enterWithOrg` call
 * above is ever removed or reordered.
 */
export async function GET(req: NextRequest) {
  try {
    const user = await getActiveUser()

    enterWithOrg(user.organizationId)

    // ADMIN ONLY. These traces carry raw prompt bodies and model answers, so a viewer
    // or analyst reading them is the reconnaissance half of the operation the
    // monitoring route already gates — reading the org's data is not a lesser
    // privilege than changing it. MEASURED: before this gate any authenticated user
    // of any tenant got HTTP 200 and every org's payloads.
    requireRole(user, 'admin')

    const limit = Math.min(Math.max(Number(req.nextUrl.searchParams.get('limit') ?? '50'), 1), 100)
    return NextResponse.json({ ok: true, traces: getRecentTraces(limit, user.organizationId) })
  } catch (e) {
    return handleApiError(e, 'Failed to load traces.')
  }
}
