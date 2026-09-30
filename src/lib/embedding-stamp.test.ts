import { describe, expect, test } from 'bun:test'

import { compareEmbeddingStamps, parseEmbeddingStampVerdict } from '@/lib/embedding-stamp'

/**
 * The comparison behind the Knowledge → External Vector DB warning.
 *
 * WHAT IT STANDS IN FOR: `retrieveRelevantChunks` decides a chunk's vector is usable with
 * `chunk.embeddingModel === queryEmbedding.model`. So this helper must answer the SAME question the
 * retriever will answer, with the same precision — a friendlier comparison here would show a green
 * panel to an install where every semantic score is 0, which is the exact defect the warning exists
 * to expose. The `not.toBe('match')` assertions below are the load-bearing ones: 'unknown' and
 * 'mismatch' are both non-matches, but conflating them sends an operator to re-embed documents whose
 * state nobody has actually measured.
 */
describe('compareEmbeddingStamps', () => {
  test('identical stamps agree', () => {
    expect(compareEmbeddingStamps('bge-m3', 'bge-m3')).toBe('match')
  })

  test('different models at the SAME width disagree — the case the dimension fields cannot see', () => {
    // Measured shape: both sides are 384-dimensional, so nothing on the form looks wrong while the
    // retriever refuses every chunk.
    expect(compareEmbeddingStamps('paraphrase-multilingual-MiniLM-L12-v2', 'text-embedding-3-small')).toBe(
      'mismatch',
    )
  })

  test('a prefixed id does NOT match its bare form', () => {
    /*
     * DELIBERATE, and the reason is a measured trap rather than a style preference: the dev install's 55
     * chunks carry the BARE id while clearing the model box resolves to the `sentence-transformers/`-
     * prefixed constant. The retriever compares exact strings, so it treats that pair as different
     * vectors — and the operator's "obvious" repair (clear the box) would NOT fix it. Normalising the
     * prefix here would report 'match' for the pair that is actually broken.
     */
    expect(compareEmbeddingStamps('paraphrase-multilingual-MiniLM-L12-v2', 'sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2')).toBe('mismatch')
    expect(compareEmbeddingStamps('sentence-transformers/x', 'X')).toBe('mismatch')
  })

  test('case is significant, because it is significant to the retriever', () => {
    expect(compareEmbeddingStamps('BGE-M3', 'bge-m3')).toBe('mismatch')
  })

  test('surrounding whitespace on either side is trimmed', () => {
    // A stored value written by an older path may carry padding; a padded-but-identical pair DOES
    // retrieve, because the retriever embeds with the trimmed config value and compares the stamps it
    // reads. Reporting 'mismatch' here would be a false alarm.
    expect(compareEmbeddingStamps('  bge-m3 ', 'bge-m3')).toBe('match')
    expect(compareEmbeddingStamps('bge-m3', '\tbge-m3\n')).toBe('match')
  })

  test('a whitespace-only stamp is "unknown", never "mismatch"', () => {
    // The one-sided cases: there is no pair to compare, and a warning built on an unmeasured half
    // would tell an operator to re-embed for a reason the code cannot actually state.
    expect(compareEmbeddingStamps('   ', 'bge-m3')).toBe('unknown')
    expect(compareEmbeddingStamps('bge-m3', '   ')).toBe('unknown')
  })

  test('a missing side is "unknown" rather than a pass OR a failure', () => {
    /*
     * 'unknown' is its own verdict, not a shade of 'match'. A fresh install (nothing embedded yet) and
     * an install with no LLM config must both land here: rendering either as 'match' tells an operator
     * their embeddings are healthy when nothing has been compared, and rendering either as 'mismatch'
     * tells them to re-embed on the strength of no evidence.
     */
    expect(compareEmbeddingStamps(null, 'bge-m3')).toBe('unknown')
    expect(compareEmbeddingStamps('bge-m3', null)).toBe('unknown')
    expect(compareEmbeddingStamps(undefined, 'bge-m3')).toBe('unknown')
    expect(compareEmbeddingStamps('bge-m3', undefined)).toBe('unknown')
    expect(compareEmbeddingStamps(null, null)).toBe('unknown')
  })

  test('both sides blank is "unknown", and specifically not "match"', () => {
    // The trap this pins: `'' === ''` is true, so the naive implementation answers 'match' for two
    // blanks — reporting an unconfigured, unembedded install as a healthy agreement.
    expect(compareEmbeddingStamps('', '')).toBe('unknown')
    expect(compareEmbeddingStamps('', '')).not.toBe('match')
  })

  test('the whole verdict set is reachable from this one function', () => {
    // A single assertion that catches a helper collapsed to a constant: both directions observed.
    const verdicts = new Set(
      [
        compareEmbeddingStamps('a', 'a'),
        compareEmbeddingStamps('a', 'b'),
        compareEmbeddingStamps(null, 'a'),
      ].map(String),
    )
    expect([...verdicts].sort()).toEqual(['match', 'mismatch', 'unknown'])
  })
})

/**
 * The narrowing applied to the SERVER's verdict before the panel renders a warning from it.
 *
 * WHY IT NEEDS ITS OWN TESTS: the panel switches on exact literals in its JSX, so an inline
 * `=== 'match' || === 'mismatch'` check and a plain cast are behaviourally identical THERE — an
 * assertion written against the rendered HTML cannot tell them apart, and a "guard" that passes under
 * both implementations proves nothing (silent-failure class #17). Extracting the narrowing makes the
 * difference observable: these assertions fail if it stops rejecting, and fail if it starts inventing.
 */
describe('parseEmbeddingStampVerdict', () => {
  test('the two actionable verdicts pass through unchanged', () => {
    expect(parseEmbeddingStampVerdict('match')).toBe('match')
    expect(parseEmbeddingStampVerdict('mismatch')).toBe('mismatch')
  })

  test('an explicit "unknown" stays "unknown"', () => {
    expect(parseEmbeddingStampVerdict('unknown')).toBe('unknown')
  })

  test('a differently-cased verdict does NOT pass — the warning branch is case-sensitive', () => {
    // 'MATCH' off the wire would slip past a `toLowerCase()`-based narrowing and then render as a
    // silent non-match in the JSX, which is the failure this narrowing exists to prevent.
    expect(parseEmbeddingStampVerdict('MATCH')).toBe('unknown')
    expect(parseEmbeddingStampVerdict('Mismatch')).toBe('unknown')
  })

  test('a near-miss string is rejected rather than trusted', () => {
    // A value that merely CONTAINS a verdict is not a verdict — proxied or hand-written payloads.
    expect(parseEmbeddingStampVerdict('match ')).toBe('unknown')
    expect(parseEmbeddingStampVerdict(' match')).toBe('unknown')
    expect(parseEmbeddingStampVerdict('matched')).toBe('unknown')
    expect(parseEmbeddingStampVerdict('no-match')).toBe('unknown')
  })

  test('non-string values never become an actionable verdict', () => {
    // `typeof value === 'string'` is implied by the literal comparisons, but pinning the shapes that
    // actually arrive off JSON (missing key, null, numbers, nested objects) is what makes this a guard
    // rather than a restatement of the implementation.
    expect(parseEmbeddingStampVerdict(undefined)).toBe('unknown')
    expect(parseEmbeddingStampVerdict(null)).toBe('unknown')
    expect(parseEmbeddingStampVerdict('')).toBe('unknown')
    expect(parseEmbeddingStampVerdict(1)).toBe('unknown')
    expect(parseEmbeddingStampVerdict(true)).toBe('unknown')
    expect(parseEmbeddingStampVerdict({ verdict: 'match' })).toBe('unknown')
    expect(parseEmbeddingStampVerdict(['match'])).toBe('unknown')
  })

  test('the narrowed set equals the verdict set, so nothing can reach the branch unnoticed', () => {
    // Both directions: every verdict survives, and no other string does.
    for (const v of ['match', 'mismatch', 'unknown'] as const) {
      expect(parseEmbeddingStampVerdict(v)).toBe(v)
    }
    expect(parseEmbeddingStampVerdict('MISMATCH')).toBe('unknown')
    expect(parseEmbeddingStampVerdict('match,mismatch')).toBe('unknown')
  })
})
