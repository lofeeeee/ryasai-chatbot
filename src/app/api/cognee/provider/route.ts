import { NextRequest, NextResponse } from 'next/server'

import { getActiveUser, requireRole, handleApiError, writeAudit } from '@/lib/session'
import { enterWithOrg } from '@/lib/prisma-tenant'
import { pushCogneeProviderConfig, readCogneeProviderConfig } from '@/lib/cognee-config-push'

/**
 * Share the app's provider credentials with the memory sidecar.
 *
 * GET  — read what the SIDECAR currently reports, so an operator sees reality rather than intent.
 *        The distinction matters here: cognee's settings are in-memory, so a push can succeed and
 *        then be lost to a restart. Showing the app's own configured value would report success for
 *        a sidecar that had already forgotten it.
 * POST — push the credentials, idempotently.
 *
 * Admin-only, like every other configuration write, and audited WITHOUT the credential: the row
 * records the model and host so an operator can tell when a share happened, never the API key.
 */
export async function GET() {
  try {
    enterWithOrg((await getActiveUser()).organizationId)
    const configured = await readCogneeProviderConfig()
    return NextResponse.json({ ok: true, data: { configured } })
  } catch (e) {
    return handleApiError(e, 'Failed to read the memory provider configuration.')
  }
}

export async function POST(_req: NextRequest) {
  try {
    const user = await getActiveUser()
    enterWithOrg(user.organizationId)
    requireRole(user, 'admin')

    const result = await pushCogneeProviderConfig()
    if (!result.ok) {
      // 502: the failure is the UPSTREAM sidecar, not this request. A 500 would send an operator
      // looking for a bug in the app when the sidecar is unreachable or has nothing to receive.
      return NextResponse.json(
        { ok: false, detail: result.detail, error: { code: 'COGNEE_PUSH_FAILED', message: result.error ?? result.detail } },
        { status: 502 },
      )
    }

    await writeAudit({
      userId: user.userId,
      action: 'COGNEE_PROVIDER_SHARED',
      severity: 'info',
      // `detail` names the model and endpoint and never the key — deliberately, since audit rows are
      // readable by any admin and a key in one would be a credential leak. The endpoint gap is
      // recorded too, because an audit trail that says only "shared" would hide the reason memory
      // still fails afterwards.
      detail: { detail: result.detail, endpointNeedsEnv: !!result.endpointNeedsEnv },
    })

    return NextResponse.json({
      ok: true,
      data: {
        detail: result.detail,
        // Passed through so the UI can show the remedy. `ok: true` is still correct: provider, model
        // and key DID land; this is the part the sidecar's API cannot carry.
        endpointNeedsEnv: !!result.endpointNeedsEnv,
        endpointValue: result.endpointValue,
        warning: result.endpointNeedsEnv ? result.error : undefined,
      },
    })
  } catch (e) {
    return handleApiError(e, 'Failed to share the provider with memory.')
  }
}
