import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
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

  test('no source file names an OpenAI embedding model in CODE', () => {
    /*
     * The second half of the same incident, and the one that survived the first fix. The product used to FALL BACK to
     * `text-embedding-3-small` (1536 dims) wherever the operator had left the box blank — in the public config mapper,
     * the embedder, the settings route and the settings PLACEHOLDER. The vector column is `vector(384)` and retrieval
     * only compares a chunk whose stamp equals the query's, so that fallback made `semanticSimilarity` 0 on every
     * result while every layer reported success. Deriving the fallback from DEFAULT_EMBEDDING_MODEL is the fix; this
     * scan is what keeps a fresh literal from coming back.
     *
     * The scan covers EVERY non-test .ts/.tsx under src/ rather than the four known files, because the defect was
     * "somewhere a model id was typed out" — a fifth copy is exactly how this returns. Comments are stripped (two
     * stages: block comments including JSX `{/* ... *​/}`, then full-line `//`), so the history written above each fix
     * may keep naming the old id; what may not exist is a CODE occurrence. `text-embedding-` is banned as a family:
     * `-3-large` is 3072-dimensional and just as incomparable with this column.
     */
    const stripComments = (src: string) =>
      src
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split('\n')
        .map((l) => (/^\s*\/\//.test(l) ? '' : l))
        .join('\n')

    const offenders: string[] = []
    for (const rel of sourceFiles()) {
      const code = stripComments(readFileSync(join(ROOT, rel), 'utf8'))
      for (const [i, line] of code.split('\n').entries()) {
        if (/text-embedding-/.test(line)) offenders.push(`${rel}:${i + 1}: ${line.trim().slice(0, 90)}`)
      }
    }
    expect(offenders).toEqual([])
  })

  test('the fallback sites USE the constant instead of restating it', () => {
    /*
     * The literal scan above cannot see this failure: a blank box could resolve to `''`, to a copied string that
     * happens not to match the pattern, or to a value assembled from somewhere else, and no literal would exist to
     * find. What must hold is that each site that decides a DEFAULT MODEL actually consumes the one fact.
     *
     * Import statements are removed before matching, so an unused import cannot satisfy this — the same class of
     * vacuity as the boot-file guard that matched an identifier surviving in a destructure one line above the call
     * it was supposed to protect. What remains is any other use: an expression, a call, a JSX attribute.
     *
     * Behaviour is pinned separately and more strongly by the suites that call the real functions:
     * `embeddings.test.ts` (blank and whitespace-only stored model → this constant, and the constant is what
     * `embedTexts` SENDS), `llm-config-runtime.test.ts` (the public config's model fallback) and
     * `src/app/api/llm-config/route.test.ts` (a blank box in PUT → this constant persisted).
     */
    const withoutImports = (src: string) => src.replace(/import\s[\s\S]*?from\s+['"][^'"]+['"]/g, '')
    const FALLBACK_SITES = [
      'src/lib/llm-config.ts',
      'src/lib/embeddings.ts',
      'src/app/api/llm-config/route.ts',
      'src/components/views/ai-configuration-view.tsx',
    ]
    const missing = FALLBACK_SITES.filter((rel) => !withoutImports(read(rel)).includes('DEFAULT_EMBEDDING_MODEL'))
    expect(missing).toEqual([])
  })
})

/**
 * Every non-test .ts/.tsx under src/, so the literal scan is not limited to the files this incident touched.
 * `readdirSync(..., { recursive: true })` lists files relative to the directory it was given, so each entry is
 * re-prefixed. Windows separators are normalised because this set is compared against repo-relative paths.
 */
function sourceFiles(): string[] {
  return readdirSync(join(ROOT, 'src'), { recursive: true, encoding: 'utf8' })
    .map((f) => f.replaceAll('\\', '/'))
    .filter((f) => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f))
    .map((f) => `src/${f}`)
    .sort()
}
