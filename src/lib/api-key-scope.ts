/**
 * API key source scoping — which sources a key may read, and what a request may narrow to.
 *
 * WHY THIS MODULE EXISTS. Before it, one API key granted access to EVERY source in the org: the
 * `ApiKey` model had no scope fields at all, and `requireExternalApiKey` returned only
 * `{ apiKeyId, organizationId, label }`. There was no way to hand a client a key limited to one
 * database or one document set, which is a business limitation rather than a missing convenience —
 * customers share a chatbot with partners and contractors, and "you see everything" is not a
 * starting point they can negotiate from.
 *
 * WHY THE RULES LIVE HERE AND NOT AT EACH CALL SITE. Enforcement that is copied into the SQL branch
 * and the RAG branch and the REST branch is enforcement that will disagree: one branch gets a fix,
 * the others keep the hole, and the difference is invisible until someone exploits it. This module
 * answers one question — "what may this request read?" — and every transport asks it.
 *
 * EMPTY MEANS ALL. `allowedIntegrationIds: []` is NOT "nothing allowed"; it is "unrestricted", which
 * is what every key created before this feature must keep doing. The opposite convention would have
 * silently revoked access for every existing integration on deploy. That choice is load-bearing and
 * is asserted by tests in both directions, because inverting it is a one-character change.
 */

/** Tool families a key can be limited to. Mirrors the router's own decision values. */
export const API_KEY_TOOLS = ['SQL', 'RAG', 'REST', 'CHAT'] as const
export type ApiKeyTool = (typeof API_KEY_TOOLS)[number]

export function isApiKeyTool(value: unknown): value is ApiKeyTool {
  return typeof value === 'string' && (API_KEY_TOOLS as readonly string[]).includes(value)
}

/** The scope stored on a key row. Empty arrays mean "unrestricted". */
export interface KeyScope {
  allowedIntegrationIds: string[]
  allowedDocumentIds: string[]
  /** Validated tool families. `readKeyScope` filters unknown names out, so these are real values. */
  allowedTools: ApiKeyTool[]
}

/** What a single request asked for. Absent fields mean "whatever the key allows". */
export interface RequestedScope {
  integrationIds?: string[]
  documentIds?: string[]
}

/** The resolved answer, handed to the retrieval and routing code. */
export interface EffectiveScope {
  /** `null` = every integration. A list = only these. */
  integrationIds: string[] | null
  /** `null` = every document. A list = only these. */
  documentIds: string[] | null
  /** `null` = every tool. A list = only these. */
  tools: ApiKeyTool[] | null
}

/** Thrown when a request asks for a source the key is not allowed to read. */
export class ScopeDeniedError extends Error {
  readonly code = 'SCOPE_DENIED'
  constructor(message: string) {
    super(message)
    this.name = 'ScopeDeniedError'
  }
}

/** Normalize a raw column value: dedupe, drop blanks, keep order stable for readable errors. */
function cleanIds(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  for (const v of raw) {
    if (typeof v === 'string' && v.trim()) seen.add(v.trim())
  }
  return [...seen]
}

/**
 * Read a key's scope off a row.
 *
 * Tolerates `null`/`undefined` for the array columns so a row loaded before the migration (or a
 * hand-written test double) resolves to "unrestricted" rather than throwing — a missing column must
 * not become a runtime failure in the auth path.
 */
export function readKeyScope(row: {
  allowedIntegrationIds?: unknown
  allowedDocumentIds?: unknown
  allowedTools?: unknown
}): KeyScope {
  const allowedTools = cleanIds(row.allowedTools).filter(isApiKeyTool)
  return {
    allowedIntegrationIds: cleanIds(row.allowedIntegrationIds),
    allowedDocumentIds: cleanIds(row.allowedDocumentIds),
    allowedTools: [...new Set(allowedTools)],
  }
}

/**
 * Intersect the key's scope with what the request asked for.
 *
 * THE ASYMMETRY HERE IS DELIBERATE, and it is the whole point of the function:
 *
 *   * Request asks for NOTHING      -> the key's scope applies (possibly "all").
 *   * Request asks for something    -> it must be a SUBSET of the key's scope.
 *
 * A request that asks for a source outside the key's scope is REJECTED, never silently narrowed.
 * Narrowing would be the friendlier-looking choice and the more dangerous one: a client asking
 * "what are Q3 sales in the ERP?" would be answered from documents instead, producing a confident
 * answer to a question nobody asked. This codebase has paid for that failure mode repeatedly — a
 * silent fallback that reports success for work it did not do.
 *
 * An unrestricted key (empty array) accepts any subset, so a client of such a key can only narrow
 * its OWN access, never exceed it.
 */
export function resolveScope(
  key: KeyScope,
  requested: RequestedScope = {},
): EffectiveScope {
  const allowedIntegrations = key.allowedIntegrationIds.length > 0 ? key.allowedIntegrationIds : null
  const allowedDocuments = key.allowedDocumentIds.length > 0 ? key.allowedDocumentIds : null
  const allowedTools = key.allowedTools.length > 0 ? key.allowedTools : null

  const reqIntegrations = cleanIds(requested.integrationIds)
  const reqDocuments = cleanIds(requested.documentIds)

  if (allowedIntegrations !== null) {
    const denied = reqIntegrations.filter((id) => !allowedIntegrations.includes(id))
    if (denied.length > 0) {
      throw new ScopeDeniedError(
        `This API key is not allowed to read ${denied.length === 1 ? 'source' : 'sources'}: ` +
          `${denied.join(', ')}. Ask the administrator who issued the key.`,
      )
    }
  }

  if (allowedDocuments !== null) {
    const denied = reqDocuments.filter((id) => !allowedDocuments.includes(id))
    if (denied.length > 0) {
      throw new ScopeDeniedError(
        `This API key is not allowed to read ${denied.length === 1 ? 'document' : 'documents'}: ` +
          `${denied.join(', ')}. Ask the administrator who issued the key.`,
      )
    }
  }

  return {
    // A request that names sources narrows to exactly those; otherwise the key's list (or null).
    integrationIds: reqIntegrations.length > 0 ? reqIntegrations : allowedIntegrations,
    documentIds: reqDocuments.length > 0 ? reqDocuments : allowedDocuments,
    tools: allowedTools,
  }
}

/** True when this scope may use a tool family. `null` tools means every family. */
export function scopeAllowsTool(scope: EffectiveScope, tool: string): boolean {
  if (scope.tools === null) return true
  return scope.tools.includes(tool as ApiKeyTool)
}

/** Human-readable summary for the key list, so an operator can see scope without opening the key. */
export function describeScope(key: KeyScope): string {
  const parts: string[] = []
  if (key.allowedIntegrationIds.length > 0) {
    parts.push(`${key.allowedIntegrationIds.length} source${key.allowedIntegrationIds.length === 1 ? '' : 's'}`)
  }
  if (key.allowedDocumentIds.length > 0) {
    parts.push(`${key.allowedDocumentIds.length} document${key.allowedDocumentIds.length === 1 ? '' : 's'}`)
  }
  if (key.allowedTools.length > 0) parts.push(key.allowedTools.join('/'))
  // Empty on every axis is "all", and saying so explicitly matters: a blank cell would read as
  // "no access configured" and an operator would either over- or under-trust it.
  return parts.length > 0 ? parts.join(' · ') : 'All sources'
}
