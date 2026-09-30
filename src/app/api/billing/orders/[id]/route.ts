/**
 * GET /api/billing/orders/[id] — status polling for the checkout flow.
 * Auth: session + allowUnlicensed.
 *
 * TENANT SCOPING — this comment used to read "Tenant scoping via the Prisma
 * extension restricts findFirst to the caller's own org", and that was FALSE,
 * which is the reason nobody re-checked it. The claim was written correctly (a
 * `findFirst` on a client-supplied id is the right shape — see the IDOR note in
 * prisma-tenant.ts) but it was never true HERE, because the extension only scopes
 * models listed in `ORG_SCOPED_MODELS` and `Order` was missing from that list.
 * The extension never fired for this query, so the route could be handed ANY
 * order id in the install and return that org's `status`, `months`, `amountIdr`
 * and `licenseIssued`.
 *
 * The fix was one word in `ORG_SCOPED_MODELS` (`'order'`), not a change here —
 * but the MISSTATEMENT was the defect that let it live: a guard you believe
 * exists is worse than one you know is missing. The claim is now verified rather
 * than asserted, by `src/lib/tenant-scope-coverage.test.ts` (which fails if any
 * `organizationId`-bearing model is absent from the set) and by the behavioural
 * test in `src/lib/prisma-tenant.test.ts` (which drives the real extension
 * handler and asserts `Order.findFirst` receives an `organizationId`).
 */
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getActiveUser, handleApiError } from '@/lib/session'
import { enterWithOrg } from '@/lib/prisma-tenant'

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await getActiveUser({ allowUnlicensed: true })
    enterWithOrg(user.organizationId)

    const { id } = await ctx.params
    // findFirst, NOT findUnique: `id` is client-supplied, and a unique `where`
    // cannot receive the injected `organizationId` (Prisma rejects extra fields on
    // a unique filter), so findUnique would be unscoped by construction. The org
    // term that makes this safe is appended by the tenant extension because
    // `Order` is now in ORG_SCOPED_MODELS.
    const order = await db.order.findFirst({
      where: { id },
      select: { status: true, months: true, amountIdr: true, licenseKeyIssued: true },
    })
    if (!order) {
      return NextResponse.json({ ok: false, error: 'Order not found.' }, { status: 404 })
    }

    return NextResponse.json({
      ok: true,
      order: {
        status: order.status,
        months: order.months,
        amountIdr: order.amountIdr,
        licenseIssued: Boolean(order.licenseKeyIssued),
      },
    })
  } catch (e) {
    return handleApiError(e, 'Failed to load billing order.')
  }
}
