import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { generateApiKey, maskApiKey } from '@/lib/api-keys'
import { getActiveUser, requireRole, handleApiError, writeAudit } from '@/lib/session'
import { enterWithOrg } from '@/lib/prisma-tenant'
import { readKeyScope, describeScope } from '@/lib/api-key-scope'
import { describeScopeProblems } from '@/lib/api-key-scope-guard'

interface CreateApiKeyBody {
  label?: string
  requestLimitPerMinute?: number | null
  dailyRequestLimit?: number | null
  /** Source scope. Omit or pass empty arrays for "all sources". */
  allowedIntegrationIds?: unknown
  allowedDocumentIds?: unknown
  allowedTools?: unknown
}

export async function GET() {
  try {
    enterWithOrg((await getActiveUser()).organizationId)
    const items = await db.apiKey.findMany({
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        label: true,
        keyPrefix: true,
        isActive: true,
        requestLimitPerMinute: true,
        dailyRequestLimit: true,
        lastUsedAt: true,
        revokedAt: true,
        createdAt: true,
      },
    })

    return NextResponse.json({
      ok: true,
      items: items.map((item) => ({
        ...item,
        maskedKey: maskApiKey(item.keyPrefix),
      })),
    })
  } catch (e) {
    return handleApiError(e, 'Failed to load API keys.')
  }
}

export async function POST(req: NextRequest) {
  try {
    const user = await getActiveUser()
    enterWithOrg(user.organizationId)
    requireRole(user, 'admin')

    const body = (await req.json().catch(() => ({}))) as CreateApiKeyBody
    const label = (body.label ?? '').trim()
    if (!label) {
      return NextResponse.json(
        { ok: false, error: 'API key label is required.' },
        { status: 400 },
      )
    }

    // Resolve the requested scope through the same reader the auth path uses, so what is SAVED is
    // exactly what will be ENFORCED. Parsing it differently here (e.g. keeping unknown tool names)
    // would create a key whose stored scope and effective scope disagree.
    const scope = readKeyScope({
      allowedIntegrationIds: body.allowedIntegrationIds,
      allowedDocumentIds: body.allowedDocumentIds,
      allowedTools: body.allowedTools,
    })

    // Refuse a scope that is ALREADY broken, before the key exists.
    //
    // A key issued pointing at a deleted source fails every request with an error its owner cannot
    // act on, and the admin only finds out from a support ticket. Failing here turns a runtime
    // mystery into a form message. (Runtime enforcement still exists — a source can disappear later
    // — but this catches the case we can see coming.)
    const scopeProblem = await describeScopeProblems(scope)
    if (scopeProblem) {
      return NextResponse.json(
        {
          ok: false,
          error: { code: 'SCOPE_SOURCE_MISSING', message: `This scope cannot be used: ${scopeProblem}` },
        },
        { status: 400 },
      )
    }

    const generated = generateApiKey()
    const item = await db.apiKey.create({
      data: {
        organizationId: user.organizationId,
        label,
        keyPrefix: generated.prefix,
        keyHash: generated.hash,
        requestLimitPerMinute: normalizeLimit(body.requestLimitPerMinute),
        dailyRequestLimit: normalizeLimit(body.dailyRequestLimit),
        allowedIntegrationIds: scope.allowedIntegrationIds,
        allowedDocumentIds: scope.allowedDocumentIds,
        allowedTools: scope.allowedTools,
      },
      select: {
        id: true,
        label: true,
        keyPrefix: true,
        isActive: true,
        requestLimitPerMinute: true,
        dailyRequestLimit: true,
        createdAt: true,
        allowedIntegrationIds: true,
        allowedDocumentIds: true,
        allowedTools: true,
      },
    })

    await writeAudit({
      userId: user.userId,
      action: 'API_KEY_CREATE',
      severity: 'warning',
      detail: { apiKeyId: item.id, label: item.label, keyPrefix: item.keyPrefix },
    })

    return NextResponse.json(
      {
        ok: true,
        apiKey: generated.plainText,
        item: {
          ...item,
          maskedKey: maskApiKey(item.keyPrefix),
        },
      },
      { status: 201 },
    )
  } catch (e) {
    return handleApiError(e, 'Failed to create API key.')
  }
}

function normalizeLimit(value: number | null | undefined): number | null {
  if (value === undefined || value === null) return null
  if (!Number.isFinite(value) || value <= 0) return null
  return Math.floor(value)
}
