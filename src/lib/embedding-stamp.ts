/**
 * Whether the embedding stamp already on the stored chunks still agrees with the model a new write would use.
 *
 * WHY THIS IS A VALUE AND NOT A CONDITION IN THE VIEW. `retrieveRelevantChunks` decides whether a chunk's
 * vector is usable with `chunk.embeddingModel === queryEmbedding.model` — a string equality. Everything that
 * can go wrong between "documents were embedded" and "search is semantic" therefore reduces to comparing two
 * strings, and the failure is invisible when it happens, because both halves look healthy on their own screen:
 * the stored side reports a real model and dimension, and the configured side reports a real model.
 *
 * MEASURED, in the install the UAT round-2 report was written against: 55 chunks stamped
 * `paraphrase-multilingual-MiniLM-L12-v2` while `LlmConfig.embeddingModel` held a different provider's model
 * name. Every similarity was 0, search silently went lexical-only, and the one panel an operator would visit
 * displayed a single consistent-looking dimension. Worse, the "obvious" repair — clearing the model box —
 * does NOT fix it: the box then resolves to a `sentence-transformers/`-prefixed id while the chunks carry the
 * BARE one, and this comparison is exact, so the mismatch survives a change that looks like a fix.
 *
 * DELIBERATELY NO PREFIX/CASE NORMALISATION. Folding `sentence-transformers/x` onto `x` here would report
 * 'match' for a pair the retriever treats as different — a guard that hides the very defect it exists to
 * expose. The comparison must have the same precision as the retrieval predicate it is standing in for.
 *
 * `'unknown'` is its own verdict, not a shade of 'match': it means NOTHING WAS COMPARED (no stamp stored yet,
 * or nothing configured to compare against), so a fresh install is never reported as healthy. Callers must
 * render it as "cannot tell", never as a pass.
 */
export type EmbeddingStampVerdict = 'match' | 'mismatch' | 'unknown'

/**
 * Narrow an untrusted value — a field off an HTTP response — to a verdict.
 *
 * WHY THIS IS NOT A CAST. The client that renders the warning receives this value as JSON, so it is
 * whatever the endpoint (or a proxy, or an older server build) put there. A cast would type-check and
 * then hand an unrecognised string to a branch that acts on it. Narrowing to the three literals means an
 * unknown value can only ever render as 'unknown', which is the honest reading of "this code does not
 * know what that verdict means".
 */
export function parseEmbeddingStampVerdict(value: unknown): EmbeddingStampVerdict {
  return value === 'match' || value === 'mismatch' ? value : 'unknown'
}

/** Trimmed, exact, case-sensitive comparison of the stored chunk stamp against the configured model. */
export function compareEmbeddingStamps(
  storedModel: string | null | undefined,
  configuredModel: string | null | undefined,
): EmbeddingStampVerdict {
  const stored = (storedModel ?? '').trim()
  const configured = (configuredModel ?? '').trim()
  // Either side missing means there is no pair to compare — an empty stamp cannot be named as "the other
  // model", and reporting a mismatch against a blank would produce a warning nobody can act on.
  if (!stored || !configured) return 'unknown'
  return stored === configured ? 'match' : 'mismatch'
}
