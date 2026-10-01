import { describe, expect, mock, test } from 'bun:test'

// Restoring a document version DELETES its chunks and re-inserts them. `KgRelation.chunkId` names a chunk id, so
// deleting the chunks first leaves relation rows pointing at ids that no longer exist: MEASURED, 131 of 131 rows
// orphaned in a development database. `dualLevelRetrieval` then looks those ids up, finds nothing, and the graph's
// global level contributes no candidates — which reads as "no entities matched", not as a broken graph.
//
// These tests drive the REAL function with a mocked db, and assert on the ORDER of the writes, because the order is
// the actual defect: a cleanup that runs after the chunk delete has nothing left to resolve.

const calls: string[] = []
const chunks = [
  { id: 'chunk-1' },
  { id: 'chunk-2' },
]
let kgDeleteArgs: unknown = null

/**
 * `kgBroken` makes the `kgRelation` property THROW ON ACCESS, which is what an install predating the table does.
 *
 * The flag is read inside the get trap rather than by swapping `dbMock.db`: MEASURED, `db` is bound to the object
 * reference at first import, so replacing that property afterwards leaves the already-imported module pointing at
 * the old object and the test silently stops exercising anything. Two earlier versions of this file did that and
 * survived the exact negative control they existed for.
 */
let kgBroken = false
const dbInner: Record<string, any> = {
    documentVersion: {
      findFirst: async () => ({ id: 'v1', documentId: 'doc-1', version: 2, snapshot: '{}' }),
    },
    document: {
      update: async () => { calls.push('document.update'); return {} },
      findFirst: async () => ({
        id: 'doc-1', organizationId: 'org-1', name: 'a.txt', mimeType: 'text/plain',
        uploadPath: '/tmp/a.txt',
      }),
    },
    documentChunk: {
      findMany: async () => { calls.push('chunk.findMany'); return chunks },
      deleteMany: async () => { calls.push('chunk.deleteMany'); return { count: chunks.length } },
      createMany: async () => { calls.push('chunk.createMany'); return { count: chunks.length } },
    },
    kgRelation: {
      deleteMany: async (args: unknown) => { calls.push('kg.deleteMany'); kgDeleteArgs = args; return { count: 2 } },
    },
}

const dbMock = {
  db: new Proxy(dbInner, {
    get(target, prop, recv) {
      if (kgBroken && prop === 'kgRelation') {
        throw new TypeError("Cannot read properties of undefined (reading 'deleteMany')")
      }
      return Reflect.get(target, prop, recv)
    },
  }),
}

mock.module('@/lib/db', () => dbMock)

mock.module('fs/promises', () => ({ readFile: async () => Buffer.from('some document text') }))
mock.module('@/lib/rag', () => ({ extractFileText: async () => ({ text: 'some document text' }) }))
mock.module('@/lib/rag-chunking', () => ({ chunkText: () => ['one chunk'] }))
mock.module('@/lib/embeddings', () => ({ embedDocumentChunks: async () => { calls.push('embed') } }))

const { restoreDocVersion } = await import('./doc-versioning')

describe('restoreVersion cleans the knowledge-graph rows it orphans', () => {
  test('the relation rows are deleted BEFORE the chunks they name', async () => {
    calls.length = 0
    const result = await restoreDocVersion('doc-1', 'v1')
    expect(result.restored).toBe(true)
    // The order IS the fix: after `chunk.deleteMany` the ids can no longer be resolved from the table.
    expect(calls.indexOf('kg.deleteMany')).toBeGreaterThanOrEqual(0)
    expect(calls.indexOf('kg.deleteMany')).toBeLessThan(calls.indexOf('chunk.deleteMany'))
  })

  test('it deletes only the rows for THIS document\'s chunks', async () => {
    calls.length = 0
    await restoreDocVersion('doc-1', 'v1')
    const where = (kgDeleteArgs as { where: { chunkId: { in: string[] } } }).where
    // A blanket delete would take another document's relations with it.
    expect(where.chunkId.in).toEqual(['chunk-1', 'chunk-2'])
  })
})

describe('a broken knowledge-graph cleanup must NOT abort the restore', () => {
  test('a db whose kgRelation access THROWS still replaces the document content', async () => {
    // MEASURED: the first version chained `.catch()` onto the call. An absent delegate throws SYNCHRONOUSLY while
    // building the call — before any promise exists — so `.catch()` never sees it, the throw escaped, and the
    // restore aborted AFTER the chunks had already been deleted. A deployment that predates the table must degrade
    // to "orphans remain", never to "document is empty".
    kgBroken = true
    try {
      calls.length = 0
      const result = await restoreDocVersion('doc-1', 'v1')
      expect(result.restored).toBe(true)
      expect(calls).toContain('chunk.createMany')
    } finally {
      kgBroken = false
    }
  })
})
