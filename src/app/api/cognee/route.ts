import { enterWithOrg } from '@/lib/prisma-tenant'
/**
 * Cognee management API — health, stats, reset, re-cognify, config.
 * GET    /api/cognee         — health + stats
 * POST   /api/cognee         — { action: 'reset' | 'recognify' | 'forget_kb' | 'update_config', ...config }
 */
import { NextRequest, NextResponse } from 'next/server'
import { getActiveUser, requireRole, writeAudit, handleApiError } from '@/lib/session'
import { cogneeStats, cogneeDiagnostics, resetCognee, cognifyBatch, forgetKnowledgeGraph, invalidateCogneeSettings, autoCognifyAll } from '@/lib/cognee'
import { db } from '@/lib/db'
import { getEmbeddingColumnDimension, getEmbeddingRuntimeConfig, embedTexts } from '@/lib/embeddings'

/**
 * Cognee's relational store URL. Admin-supplied, but it is a credential-bearing
 * connection string that the server dials out to, so it has to parse as postgres
 * — not just be truthy. Empty string clears it.
 */
function parseCogneeDbUrl(raw: unknown): { ok: true; value: string | null } | { ok: false; error: string } {
  if (raw === undefined || raw === null || raw === '') return { ok: true, value: null }
  if (typeof raw !== 'string') return { ok: false, error: 'dbUrl must be a string.' }
  const trimmed = raw.trim()
  if (!trimmed) return { ok: true, value: null }
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    return { ok: false, error: 'dbUrl is not a valid URL.' }
  }
  if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
    return { ok: false, error: 'dbUrl must use the postgres:// or postgresql:// scheme.' }
  }
  if (!parsed.hostname) return { ok: false, error: 'dbUrl is missing a host.' }
  return { ok: true, value: trimmed }
}

export async function GET() {
  try {
    const user = await getActiveUser()
    enterWithOrg(user.organizationId)
    const stats = await cogneeStats()

    // Component-level diagnosis, so the UI can explain WHY memory is unusable instead of only
    // showing a red badge. Null when memory is off or the sidecar is unreachable — the UI renders
    // "unknown" for that, never a fabricated verdict.
    //
    // Fetched in the SAME request rather than a separate endpoint: the card needs both to render one
    // coherent state, and two calls could disagree (health freshly computed, stats cached).
    const diagnostics = await cogneeDiagnostics()

    // Also return config for UI
    const config = await db.appConfig.findFirst()
    const cogneeConfig = config ? {
      enabled: config.cogneeEnabled,
      dbProvider: config.cogneeDbProvider ?? 'local',
      dbUrl: config.cogneeDbUrl ?? '',
      batchSize: config.cogneeBatchSize,
      maxRetries: config.cogneeMaxRetries,
    } : null

    /*
     * Embedding WIDTH, compared between the two places it must agree.
     *
     * `DocumentChunk.embedding` is `vector(384)` and the embedder's model is configured separately in
     * AI Configuration. When they disagree, pgvector writes are skipped and retrieval silently falls
     * back to cosine-over-JSON — slower and correct, but with NO user-visible symptom. The engine
     * logs it once (`embeddings.ts`) and then stays quiet, so an admin running a 1536-dim hosted
     * model had no way to learn that the vector leg was dead.
     *
     * Reported here so the mismatch is VISIBLE, and reported as a comparison rather than a single
     * number: one value alone cannot be wrong, only a disagreement between two can.
     */
    const columnDim = await getEmbeddingColumnDimension()
    let modelDim: number | null = null
    try {
      // A real embed call is the only honest source: the configured model STRING says nothing about
      // the vector width, and a provider can change it under a stable name. One token is enough.
      const cfg = await getEmbeddingRuntimeConfig()
      if (cfg) {
        const vectors = await embedTexts(cfg, ['x'])
        modelDim = vectors[0]?.length ?? null
      }
    } catch {
      // Embedder down or misconfigured. Reported as `null` (unknown) rather than 0, so the UI says
      // "unknown" instead of claiming a mismatch it cannot prove.
      modelDim = null
    }
    const embedding = {
      columnDimension: columnDim,
      modelDimension: modelDim,
      /** null = unknown (embedder unreachable); false = a REAL mismatch that disables pgvector. */
      matches: columnDim !== null && modelDim !== null ? columnDim === modelDim : null,
    }

    return NextResponse.json({ ok: true, data: { ...stats, config: cogneeConfig, diagnostics, embedding } })
  } catch (e) {
    return handleApiError(e, 'Failed to get cognee stats.')
  }
}

export async function POST(req: NextRequest) {
  try {
    const user = await getActiveUser()
    enterWithOrg(user.organizationId)
    // Every action below is destructive (reset/forget wipe the graph), spends LLM
    // budget (recognify), or rewrites where org data is stored (update_config's
    // dbUrl). None of it belongs to a viewer or analyst.
    requireRole(user, 'admin')

    const body = await req.json().catch(() => ({}))
    const action = body.action as string

    if (action === 'update_config') {
      const { enabled, dbProvider, dbUrl, batchSize, maxRetries } = body
      const willBeEnabled = Boolean(enabled)
      const willBeDbProvider = dbProvider === 'postgres' ? 'postgres' : 'local'
      const parsedUrl = parseCogneeDbUrl(dbUrl)
      if (!parsedUrl.ok) {
        return NextResponse.json({ ok: false, error: parsedUrl.error }, { status: 400 })
      }
      const willBeDbUrl = parsedUrl.value
      if (willBeDbProvider === 'postgres' && !willBeDbUrl) {
        return NextResponse.json(
          { ok: false, error: 'dbUrl is required when dbProvider is postgres.' },
          { status: 400 },
        )
      }
      const existing = await db.appConfig.findFirst()
      const wasEnabled = existing?.cogneeEnabled ?? false
      const wasDbProvider = existing?.cogneeDbProvider ?? 'local'
      const wasDbUrl = existing?.cogneeDbUrl ?? null

      // Purge BEFORE persisting the disable. forgetKnowledgeGraph() short-circuits
      // on isCogneeEnabled(), so the old "write disabled config, then fire-and-forget
      // the purge" order meant the graph was never actually deleted — it just
      // stopped being read, and came back intact on re-enable.
      let purged: boolean | null = null
      if (wasEnabled && !willBeEnabled) {
        purged = await forgetKnowledgeGraph().catch(() => false)
      }

      if (existing) {
        await db.appConfig.update({
          where: { id: existing.id },
          data: {
            cogneeEnabled: willBeEnabled,
            cogneeDbProvider: willBeDbProvider,
            cogneeDbUrl: willBeDbUrl,
            cogneeBatchSize: Math.max(1, Math.min(500, parseInt(batchSize) || 50)),
            cogneeMaxRetries: Math.max(0, Math.min(10, parseInt(maxRetries) || 3)),
          },
        })
      } else {
        await db.appConfig.create({
          data: {
            organizationId: user.organizationId,
            cogneeEnabled: willBeEnabled,
            cogneeDbProvider: willBeDbProvider,
            cogneeDbUrl: willBeDbUrl,
            cogneeBatchSize: Math.max(1, Math.min(500, parseInt(batchSize) || 50)),
            cogneeMaxRetries: Math.max(0, Math.min(10, parseInt(maxRetries) || 3)),
          },
        })
      }
      invalidateCogneeSettings()

      const storeChanged = wasEnabled && willBeEnabled &&
        (wasDbProvider !== willBeDbProvider || wasDbUrl !== willBeDbUrl)
      if (wasEnabled && !willBeEnabled) {
        // Already purged above, while cognee was still enabled.
      } else if (!wasEnabled && willBeEnabled) {
        // Cognee newly enabled — auto-cognify all ready documents
        void autoCognifyAll().catch(() => null)
      } else if (storeChanged) {
        // Store changed while enabled — forget stale data, re-cognify
        void forgetKnowledgeGraph().catch(() => null)
        void autoCognifyAll().catch(() => null)
      }

      await writeAudit({
        userId: user.userId,
        action: 'COGNEE_CONFIG_UPDATE',
        severity: 'warning',
        detail: {
          before: { enabled: wasEnabled, dbProvider: wasDbProvider, dbUrlSet: !!wasDbUrl },
          after: { enabled: willBeEnabled, dbProvider: willBeDbProvider, dbUrlSet: !!willBeDbUrl },
          purged,
        },
      })

      return NextResponse.json({ ok: true, data: { updated: true, purged } })
    }

    if (action === 'reset') {
      const ok = await resetCognee()
      await writeAudit({
        userId: user.userId,
        action: 'COGNEE_RESET',
        severity: 'warning',
        detail: { reset: ok },
      })
      return NextResponse.json({ ok, data: { reset: ok } })
    }

    if (action === 'forget_kb') {
      const ok = await forgetKnowledgeGraph()
      await writeAudit({
        userId: user.userId,
        action: 'COGNEE_FORGET_KB',
        severity: 'warning',
        detail: { forgotten: ok },
      })
      return NextResponse.json({ ok, data: { forgotten: ok } })
    }

    if (action === 'recognify') {
      const docs = await db.document.findMany({
        where: {
          status: 'ready',
          isEnabled: true,
          OR: [
            { cognifyStatus: null },
            { cognifyStatus: { not: 'completed' } },
          ],
        },
        include: {
          chunks: { select: { content: true, chunkIndex: true }, orderBy: { chunkIndex: 'asc' } },
        },
      })

      if (docs.length === 0) {
        return NextResponse.json({ ok: true, data: { processed: 0, failed: 0, skipped: 0, message: 'All documents already cognified' } })
      }

      const result = await cognifyBatch({
        documents: docs.map((doc) => ({
          documentId: doc.id,
          documentName: doc.name,
          chunks: doc.chunks.map((c) => ({ content: c.content, chunkIndex: c.chunkIndex })),
        })),
      })

      return NextResponse.json({ ok: true, data: result })
    }

    return NextResponse.json(
      { ok: false, error: 'Unknown action. Use: reset, forget_kb, recognify, update_config' },
      { status: 400 },
    )
  } catch (e) {
    return handleApiError(e, 'Cognee action failed.')
  }
}
