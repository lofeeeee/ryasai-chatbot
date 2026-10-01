import crypto from 'crypto'
import { db } from '@/lib/db'
import { getOrgContext } from '@/lib/prisma-tenant'
import { scopedLogger } from '@/lib/logger'

const log = scopedLogger('doc-versioning')

export interface DocVersionSnapshot {
  id: string
  documentId: string
  version: number
  contentHash: string
  chunkCount: number
  createdAt: Date
}

export async function createDocVersion(documentId: string): Promise<DocVersionSnapshot> {
  // `findFirst`, for the same reason as `restoreDocVersion` below: the tenant extension scopes only FILTER
  // operations, so a `findUnique` here read the row by id alone. Everything after this line is keyed by
  // `documentId` -- `documentChunk.findMany` is scoped, but the snapshot is WRITTEN with the version number taken
  // from the foreign row, so a caller could snapshot another tenant's document into its own version history.
  const doc = await db.document.findFirst({
    where: { id: documentId },
    select: { id: true, version: true },
  })
  if (!doc) throw new Error(`Document not found: ${documentId}`)

  const chunks = await db.documentChunk.findMany({
    where: { documentId },
    orderBy: { chunkIndex: 'asc' },
    select: { id: true, content: true },
  })

  const hash = crypto
    .createHash('sha256')
    .update(chunks.map((c) => c.content).join('\n\n'))
    .digest('hex')

  const nextVersion = doc.version + 1

  const snapshot = await db.documentVersion.create({
    data: {
      organizationId: getOrgContext()!,
      documentId,
      version: nextVersion,
      contentHash: hash,
      chunkCount: chunks.length,
    },
  })

  await db.document.update({
    where: { id: documentId },
    data: { version: nextVersion },
  })

  return snapshot
}

export async function listDocVersions(documentId: string): Promise<DocVersionSnapshot[]> {
  return db.documentVersion.findMany({
    where: { documentId },
    orderBy: { version: 'desc' },
  })
}

export async function restoreDocVersion(
  documentId: string,
  versionId: string,
): Promise<{ version: number; restored: boolean }> {
  const version = await db.documentVersion.findFirst({
    where: { id: versionId, documentId },
  })
  if (!version) throw new Error(`Version not found: ${versionId}`)

  // MUST be `findFirst`, not `findUnique`: the tenant extension scopes only the FILTER operations, so a
  // `findUnique` where-clause is used verbatim and the row id alone decides the result. A caller passing a
  // document id from another organization moved that tenant's version pointer and, when it had an `uploadPath`,
  // had its chunks deleted and re-embedded -- a cross-tenant DESTRUCTIVE write. The `documentVersion` lookup above
  // is already org-scoped because that model carries `organizationId` and the extension filters `findFirst`,
  // which is why the hole was in this second read and not in the first.
  const doc = await db.document.findFirst({
    where: { id: documentId },
    select: { id: true, uploadPath: true, name: true, type: true, mimeType: true, organizationId: true },
  })
  if (!doc) throw new Error(`Document not found: ${documentId}`)

  // Update version number
  await db.document.update({
    where: { id: documentId },
    data: { version: version.version },
  })

  if (doc.uploadPath) {
    // Re-read and re-embed from the original uploaded file.
    const { readFile } = await import('fs/promises')
    try {
      const buffer = await readFile(doc.uploadPath)
      const { extractFileText } = await import('@/lib/rag')
      const { chunkText } = await import('@/lib/rag-chunking')
      const file = new File([buffer], doc.name, { type: doc.mimeType || 'application/octet-stream' })
      const { text } = await extractFileText(file)
      const chunks = chunkText(text)

      /*
       * Order matters, and the missing first step left ORPHANS: `KgRelation.chunkId` points at a chunk id, so
       * deleting the chunks first left relation rows naming ids that no longer exist. MEASURED: 131 of 131 rows in a
       * development database were orphaned this way, against 0 in production — the shape of a bug that only shows up
       * after someone restores a version. The rows are deleted FIRST here, in the same operation that removes the
       * chunks they describe, so the two cannot drift apart.
       *
       * A `try` block, NOT `.catch()` chained onto the promise. The first version used `.catch()` and MEASURED it
       * was not equivalent: a deployment (or a test double) whose `db` has no `kgRelation` delegate throws
       * SYNCHRONOUSLY while building the call, before any promise exists to catch it — so the throw escaped the
       * handler, aborted the whole restore, and left the document with its chunks already deleted. Cleaning the
       * graph is best-effort; replacing the document's content is not.
       */
      try {
        const ownChunks = await db.documentChunk.findMany({ where: { documentId }, select: { id: true } })
        await db.kgRelation.deleteMany({ where: { chunkId: { in: ownChunks.map((c) => c.id) } } })
      } catch (e) {
        log.warn('could not clean knowledge-graph rows for a restored document; continuing with the restore', {
          documentId,
          error: e instanceof Error ? e.message : String(e),
        })
      }
      // Delete existing chunks, then re-insert the restored content.
      await db.documentChunk.deleteMany({ where: { documentId } })
      await db.documentChunk.createMany({
        data: chunks.map((c, i) => ({
          organizationId: doc.organizationId,
          documentId,
          chunkIndex: i,
          content: c,
          tokenCount: Math.ceil(c.length / 4),
        })),
      })

      // Re-embed the restored chunks.
      const { embedDocumentChunks } = await import('@/lib/embeddings')
      await embedDocumentChunks({ documentId })

      return { version: version.version, restored: true }
    } catch {
      // ponytail: original file no longer on disk — can't restore content,
      // but the version pointer is still updated above.
      return { version: version.version, restored: false }
    }
  }

  return { version: version.version, restored: false }
}
