import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { EMBEDDING_DIMENSIONS, DEFAULT_EMBEDDING_MODEL } from './constants'

/**
 * THE EMBEDDING DIMENSION IS ONE FACT STATED IN SEVERAL PLACES, and this guard exists because they disagreed.
 *
 * MEASURED HISTORY: the database column is `vector(384)`, the bundled embedder returns 384, and both the development
 * and production databases hold 384-dimensional rows — while the APPLICATION defaulted to 1536 (the OpenAI figure,
 * which nothing in this stack produces). Retrieval only compares a chunk whose `embeddingModel` matches the query's,
 * so that disagreement produced `semanticSimilarity: 0` on every result and search silently fell back to
 * lexical-only. Nothing errored. The vector store panel even displayed "1536" beside 384-dimensional data.
 *
 * A silent zero is the worst possible failure mode here, so the rule is enforced rather than documented: change the
 * model and this fails until the schema is changed with it. There is no legitimate state where these differ.
 */
const ROOT = join(import.meta.dir, '..', '..')
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8')

describe('embedding dimension — the schema, the code and the packaged model must agree', () => {
  test('the declared dimension is 384, the value the shipped stack produces', () => {
    expect(EMBEDDING_DIMENSIONS).toBe(384)
  })

  test('the Prisma column matches the constant EXACTLY', () => {
    /*
     * The assertion that matters. `vector(384)` in the schema and `EMBEDDING_DIMENSIONS` in the code are one fact;
     * if a future change moves one and not the other, every vector write mismatches and retrieval degrades to
     * lexical-only with no error anywhere.
     */
    const schema = read('prisma/schema.prisma')
    const declared = [...schema.matchAll(/Unsupported\("vector\((\d+)\)"\)/g)].map((m) => Number(m[1]))
    expect(declared.length).toBeGreaterThan(0)
    for (const d of declared) expect(d).toBe(EMBEDDING_DIMENSIONS)
  })

  test('the packaged model is the one declared, and it is a 384-dim model', () => {
    // The model name carries no dimension; the pairing is what matters, so both live in constants.ts together.
    expect(DEFAULT_EMBEDDING_MODEL).toBe('sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2')
    // The bundled service and compose must default to it, or a fresh install embeds with something else.
    const compose = read('docker-compose.yml')
    expect(compose).toContain(`EMBEDDING_MODEL=\${EMBEDDING_MODEL:-${DEFAULT_EMBEDDING_MODEL}}`)
  })

  test('the memory sidecar expects the SAME dimension as the app stores', () => {
    /*
     * cognee validates the dimension of what the endpoint RETURNED and fails a write when it disagrees, with an error
     * that names the wrong cause ("List should have at least 3072 items"). Its default was 1536 while the bundled
     * embedder returns 384, so leaving it unset produced that error for a mismatch the operator had not made.
     */
    const compose = read('docker-compose.yml')
    expect(compose).toContain(`COGNEE_EMBEDDING_DIMENSIONS:-${EMBEDDING_DIMENSIONS}`)
  })

  test('the VectorStoreConfig default matches too, not only the chunk column', () => {
    /*
     * A SIXTH place the number lived, missed by the first pass through this work: `VectorStoreConfig.vectorSize` had
     * `@default(1536)`, so a config row created without an explicit size disagreed with both the `vector(384)` column
     * it describes and the embedder that fills it. Two numbers, one fact — so both are asserted against the constant
     * rather than only the one that happened to be found first.
     */
    const schema = read('prisma/schema.prisma')
    const m = schema.match(/vectorSize\s+Int\s+@default\((\d+)\)/)
    expect(m).not.toBeNull()
    expect(Number(m![1])).toBe(EMBEDDING_DIMENSIONS)
  })

  test('the runtime-created FTS index is ALSO declared, or db push tries to drop it', () => {
    /*
     * MEASURED DEFECT, found while changing the dimension and unrelated to it: `ensureRagFtsTable()` creates
     * `DocumentChunk_tsv_idx` with raw DDL at runtime, so Prisma could not see it — every `db push` treated the index
     * as drift and emitted `DROP INDEX "DocumentChunk_tsv_idx"`. On a live install that silently removes BM25
     * ranking. It was caught on production only because `db push` ALSO refuses to drop a COLUMN holding data (the
     * `tsv` one) and exited 1 before reaching the index.
     *
     * The `tsv` column is declared as `Unsupported("tsvector")` for the same reason. The INDEX was not, and the
     * schema accepts `@@index([tsv], type: Gin)` — verified by `prisma migrate diff` returning no DROP once it is
     * present. So the two creators no longer disagree, and this asserts it stays that way.
     */
    const schema = read('prisma/schema.prisma')
    expect(schema).toMatch(/@@index\(\[tsv\],\s*type:\s*Gin\)/)
  })

  test('no source file carries a stale numeric default', () => {
    /*
     * Comments are allowed to mention 1536 — several explain this incident, and deleting them would delete the
     * reasoning. What must not exist is a CODE default, which is what the previous version of this product had in
     * four places (the vector-store route, its panel, the provider presets and `vector-stores.ts`).
     */
    const offenders: string[] = []
    for (const rel of [
      'src/lib/vector-stores.ts',
      'src/lib/db-provider-presets.ts',
      'src/app/api/vector-store/route.ts',
      'src/components/views/knowledge-base/vector-store-panel.tsx',
    ]) {
      const src = read(rel)
      for (const [i, line] of src.split('\n').entries()) {
        const code = line.replace(/\/\/.*$/, '').replace(/^\s*\*.*$/, '')
        if (/\b(1536|3072)\b/.test(code)) offenders.push(`${rel}:${i + 1}: ${line.trim().slice(0, 80)}`)
      }
    }
    expect(offenders).toEqual([])
  })
})
