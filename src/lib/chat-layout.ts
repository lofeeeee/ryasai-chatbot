export function chatShellGridClass() {
  return 'md:grid-cols-[auto_minmax(0,1fr)]'
}

export function chatSessionPanelWidthClass(sessionRailCollapsed: boolean) {
  return sessionRailCollapsed
    ? 'md:w-12'
    : 'md:w-[clamp(200px,18vw,260px)]'
}

export function citationDetailLabel(type: string) {
  return type === 'DATABASE' ? 'View SQL query' : 'View source details'
}

/**
 * The badge on a retrieved document citation.
 *
 * WHY NOT A PERCENTAGE. `Citation.score` is the FUSED RRF value
 * (`rag-retrieval.ts`), not a similarity: RRF sums `1 / (k + rank)` across
 * retrievers, so a document found by both legs at rank 1 scores 0.0328 and the best
 * possible result renders as "3%". It is meaningless as a percentage at any `k` — at
 * k=1 the same document would read "100%", turning an ordinal position into an
 * apparent confidence. The rows that DO mean something as a percentage
 * (`scoreBreakdown.semanticSimilarity`, `bm25`) are not what this field carries.
 *
 * So the badge reports what the number actually is: the rank the document came back
 * at.
 *
 * WHY IT PREFERS A CARRIED RANK OVER `idx`. The array position is only the retrieval
 * position when the array is the retrieval result. In the answer path it is not:
 * `tool-router-agentic` concatenates the citations of every tool run, so the second
 * document of a run can sit at index 5 while it genuinely was that run's Match #2.
 * MEASURED IN UAT with the index-derived label: the best chunk of a four-document
 * result displayed as "Match #3" because the array had been reordered after the
 * labels were computed. `rank` is stamped where the order becomes final
 * (`stampRetrievedRanks`), so a citation that carries one is labelled from it. `idx`
 * remains the fallback for citations that carry no rank — DATABASE rows, and any
 * DOCUMENT citation built before ranks were carried.
 *
 * Returns null when the citation carries no score, so an unranked citation (a
 * DATABASE row, which has no `score`) renders no badge rather than "Match #0".
 */
export function citationRankLabel(
  idx: number,
  score: number | undefined | null,
  rank?: number | null,
): string | null {
  if (typeof score !== 'number' || !Number.isFinite(score)) return null
  // `rank` is validated as a positive integer: a rank of 0 or NaN would render
  // "Match #0"/"Match #NaN", which is worse than falling back to the position.
  const position = typeof rank === 'number' && Number.isInteger(rank) && rank > 0 ? rank : idx + 1
  return `Match #${position}`
}
