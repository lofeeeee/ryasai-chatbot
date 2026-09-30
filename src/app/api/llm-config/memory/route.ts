import { NextRequest, NextResponse } from 'next/server'

import { getActiveUser, requireRole, handleApiError, writeAudit } from '@/lib/session'
import { enterWithOrg } from '@/lib/prisma-tenant'
import { db } from '@/lib/db'
import { encryptConfig, decryptConfig } from '@/lib/crypto'
import { maskSecret, normalizeBaseUrl, resolveMemoryConfigRow } from '@/lib/llm-config'
import { pushCogneeProviderConfig } from '@/lib/cognee-config-push'

/**
 * AI Memory's OWN LLM provider — the credentials the memory sidecar extracts with.
 *
 * GET     read the memory row, masked, plus WHICH source memory would actually use.
 * PUT     save a dedicated memory provider, then push it to the sidecar.
 * DELETE  drop the dedicated row so memory follows chat again, then re-push.
 *
 * WHY A SEPARATE ROW RATHER THAN A COPY. Memory extraction is a different job from answering: it is
 * high-volume, structurally repetitive and quality-tolerant — the schema is what matters, not prose.
 * An operator running a cheap fast model beside an expensive answering model wants them separate.
 * Before this route the only way to express that was editing `.env.cognee` and restarting the
 * container by hand, because the sidecar's credentials were a hard copy of the chat row.
 *
 * `source` IS THE LOAD-BEARING FIELD. Every install that upgrades into this feature has no memory row
 * and works today, so "unset" must mean "follow chat" rather than "unconfigured". Returning the
 * resolved source lets the UI say which of the two states it is in; a screen that guessed would make
 * the feature invisible on exactly the installs that have not used it yet.
 *
 * THE ENDPOINT CANNOT BE PUSHED, and this route says so rather than pretending. cognee's settings API
 * carries provider/model/key only — measured: posting `endpoint`, `api_base`, `baseUrl` and
 * `apiEndpoint` all stored `''`. So a saved baseUrl is recorded here, reported back as
 * `endpointNeedsEnv` with the exact line for `.env.cognee`, and the UI renders it as a manual step.
 * Reading the baseUrl out of this row and reporting `ok` would be a claim the sidecar cannot honour.
 */

/** The masked view of one row, so GET and PUT cannot drift on shape or masking. */
function publicMemoryConfig(row: {
  provider: string
  baseUrl: string
  model: string
  encryptedApiKey: string
} | null) {
  if (!row) return null
  let apiKeyMasked: string | null = null
  try {
    const cfg = decryptConfig(row.encryptedApiKey)
    apiKeyMasked = typeof cfg.apiKey === 'string' ? maskSecret(cfg.apiKey) : '••••'
  } catch {
    // A decryption failure must not leak ciphertext and must not crash the screen — the same
    // degradation the chat config view already performs.
    apiKeyMasked = '••••'
  }
  return {
    provider: row.provider,
    baseUrl: row.baseUrl,
    model: row.model,
    apiKeyMasked,
  }
}

export async function GET() {
  try {
    enterWithOrg((await getActiveUser()).organizationId)
    const memoryRow = await resolveMemoryConfigRow()
    return NextResponse.json({
      ok: true,
      data: {
        // null means "no dedicated row" — memory follows chat. The UI renders that state explicitly,
        // it is not an error and not an empty form waiting to be filled in.
        memory: publicMemoryConfig(memoryRow),
        source: memoryRow ? 'memory' : 'chat',
      },
    })
  } catch (e) {
    return handleApiError(e, 'Failed to load the AI memory configuration.')
  }
}

interface PutBody {
  provider?: string
  baseUrl?: string
  apiKey?: string
  model?: string
}

export async function PUT(req: NextRequest) {
  try {
    const user = await getActiveUser()
    enterWithOrg(user.organizationId)
    requireRole(user, 'admin')

    const body = (await req.json().catch(() => ({}))) as PutBody
    const VALID_PROVIDERS = new Set(['OPENAI_COMPATIBLE', 'ANTHROPIC_COMPATIBLE'])
    const provider = VALID_PROVIDERS.has((body.provider ?? '').trim().toUpperCase())
      ? (body.provider as string).trim().toUpperCase()
      : 'OPENAI_COMPATIBLE'
    const model = (body.model ?? '').trim()
    const apiKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : ''

    let baseUrl: string
    try {
      baseUrl = normalizeBaseUrl(body.baseUrl ?? '')
    } catch (e) {
      return NextResponse.json(
        { ok: false, error: e instanceof Error ? e.message : 'Base URL is invalid.' },
        { status: 400 },
      )
    }
    if (!baseUrl) {
      return NextResponse.json(
        {
          ok: false,
          error:
            'A base URL is required for a dedicated memory provider. Leave it empty and delete the memory configuration instead to follow the chat provider.',
        },
        { status: 400 },
      )
    }
    if (!model) {
      return NextResponse.json(
        { ok: false, error: 'A model is required for a dedicated memory provider.' },
        { status: 400 },
      )
    }

    const existing = await resolveMemoryConfigRow()
    // Same rule as the chat route: a blank key keeps the stored one on update, and is required on
    // first create — otherwise the row would exist with no usable credential and memory would fail
    // with an auth error that names the provider rather than the empty field.
    if (!apiKey && !existing) {
      return NextResponse.json(
        { ok: false, error: 'API key is required on first configuration.' },
        { status: 400 },
      )
    }

    const payload = {
      provider,
      baseUrl,
      model,
      ...(apiKey ? { encryptedApiKey: encryptConfig({ apiKey }) } : {}),
    }

    if (existing) {
      await db.llmConfig.update({ where: { id: existing.id }, data: payload })
    } else {
      await db.llmConfig.create({
        data: {
          organizationId: user.organizationId,
          purpose: 'memory',
          ...payload,
          encryptedApiKey: encryptConfig({ apiKey }),
        },
      })
    }

    await writeAudit({
      userId: user.userId,
      action: 'LLM_CONFIG_UPDATE',
      severity: 'warning',
      detail: {
        purpose: 'memory',
        provider,
        baseUrl,
        model,
        keyRotated: apiKey.length > 0,
      },
    })

    // Push immediately: the sidecar keeps these settings IN MEMORY only, so a save that did not push
    // would appear to work and stop extracting at the next container restart. Best-effort — the save
    // itself has already succeeded, and a memory problem must not fail a configuration write.
    const pushed = await pushCogneeProviderConfig()

    return NextResponse.json({
      ok: true,
      data: {
        memory: await readMaskedMemoryRow(),
        source: 'memory',
        push: {
          ok: pushed.ok,
          detail: pushed.detail,
          error: pushed.error,
          endpointNeedsEnv: !!pushed.endpointNeedsEnv,
          endpointValue: pushed.endpointValue,
        },
      },
    })
  } catch (e) {
    return handleApiError(e, 'Failed to save the AI memory configuration.')
  }
}

export async function DELETE() {
  try {
    const user = await getActiveUser()
    enterWithOrg(user.organizationId)
    requireRole(user, 'admin')

    const existing = await resolveMemoryConfigRow()
    if (existing) {
      await db.llmConfig.delete({ where: { id: existing.id } })
      await writeAudit({
        userId: user.userId,
        action: 'LLM_CONFIG_UPDATE',
        severity: 'warning',
        // Records the REMOVAL, and that memory therefore follows chat again. An audit trail that
        // only recorded saves would leave an operator unable to explain a later model change.
        detail: { purpose: 'memory', cleared: true, model: existing.model },
      })
    }

    // Re-push so the sidecar actually stops using the removed credentials. Without this the old
    // model would keep extracting until the container restarted — the "clear it and nothing changes"
    // failure this whole feature would otherwise inherit.
    const pushed = await pushCogneeProviderConfig()

    return NextResponse.json({
      ok: true,
      data: {
        memory: null,
        source: 'chat',
        cleared: !!existing,
        push: {
          ok: pushed.ok,
          detail: pushed.detail,
          error: pushed.error,
          endpointNeedsEnv: !!pushed.endpointNeedsEnv,
          endpointValue: pushed.endpointValue,
        },
      },
    })
  } catch (e) {
    return handleApiError(e, 'Failed to clear the AI memory configuration.')
  }
}

async function readMaskedMemoryRow() {
  return publicMemoryConfig(await resolveMemoryConfigRow())
}
