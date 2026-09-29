/**
 * The sentinel id for the "document corpus" entry in the composer's source picker.
 *
 * WHY A SENTINEL AND NOT A REAL ID: the corpus has no single row to point at. The picker resolves this entry to
 * "the knowledge base documents in this org", which is what RAG searches anyway, so there is nothing to enumerate.
 *
 * WHY IT IS IN A SHARED MODULE: two files must agree on its value and its MEANING — `chat-view.tsx` builds the
 * option, and `use-chat-send.ts` decides that this value becomes `pinToDocuments` rather than `integrationId`.
 * Sending it as an `integrationId` would fail: `/send` validates that against `Integration` and returns 400 for an
 * id that matches nothing, so the turn would break rather than fall back.
 */
export const DOCUMENTS_SOURCE_ID = '__documents__'
