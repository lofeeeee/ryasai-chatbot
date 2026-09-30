/**
 * Where a retrieved chunk learns — and re-learns — its "Match #N" position.
 *
 * WHY THIS IS A SHARED STEP RATHER THAN A LINE AT EACH CALL SITE. A rank is only meaningful while it
 * describes the order its consumer actually receives, and two layers invalidate a rank stamped earlier:
 *
 *   - `retrieveRelevantChunks` stamps per QUERY, but `retrieveWithReflection` merges up to three query
 *     expansions and re-selects. The merged order is a NEW order, so a per-query rank then describes a
 *     list that no longer exists.
 *   - In the answer path `tool-router-agentic` CONCATENATES the citations of every tool run, so a
 *     position in the final array is not the position retrieval produced either.
 *
 * So: stamp where the order becomes final, and a consumer that receives a carried rank must use it
 * instead of the array position. Mutates in place and returns the same array, so a caller can wrap the
 * value it already holds.
 *
 * WHY THIS LIVES IN ITS OWN MODULE rather than in `rag.ts`: `rag-retrieval.ts` and `intent-pipeline.ts`
 * import names from `@/lib/rag` statically, and several tests partially mock that module — a mock factory
 * must export every name its consumers import, or the file dies with
 * `SyntaxError: Export named 'selectTopRetrievedChunks' not found`. Adding a name to `rag.ts` would have
 * forced every one of those factories to learn it. Nobody mocks this leaf, so the blast radius is zero.
 */
export function stampRetrievedRanks<T extends { rank?: number }>(chunks: T[]): T[] {
  chunks.forEach((chunk, i) => {
    chunk.rank = i + 1
  })
  return chunks
}
