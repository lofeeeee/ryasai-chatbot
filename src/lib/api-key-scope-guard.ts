import { db } from '@/lib/db'
import { describeScope, type KeyScope } from '@/lib/api-key-scope'

/**
 * Validate that every source an API key is scoped to still EXISTS and is USABLE.
 *
 * DECISION: FAIL CLOSED. If a key names a source that has been deleted, deactivated, or has fallen
 * into an error state, requests made with that key are REFUSED — they are not silently answered from
 * the remaining sources.
 *
 * WHY, given the friendlier alternative. "Just drop the missing source and answer from the rest" is
 * the same silent-narrowing mistake that `resolveScope` already refuses for an explicit request, one
 * level up. A client whose key was scoped to the ERP asking "what are Q3 sales?" would receive an
 * answer synthesised from policy documents, with citations that look legitimate. Nobody sees an
 * error, the answer is wrong, and the operator has no signal that their key scope is broken.
 *
 * The cost of failing closed is an explicit error naming the missing source, which is exactly the
 * information an admin needs to fix the key. An out-of-date scope is a configuration fault, and a
 * configuration fault that reports itself is cheaper than one that hides.
 *
 * WHY A SEPARATE PASS RATHER THAN A JOIN. The scope lists are ids; whether each is still usable lives
 * in three different tables with three different notions of "usable" (`Integration.status`,
 * `Document.status` + `isEnabled`, `RestApiConnector.isActive`). Resolving them here keeps that
 * knowledge in one place instead of spreading it across the transports that consume the scope.
 */

export class ScopeSourceMissingError extends Error {
  readonly code = 'SCOPE_SOURCE_MISSING'
  constructor(message: string) {
    super(message)
    this.name = 'ScopeSourceMissingError'
  }
}

/** At most this many ids per category are resolved in one query batch. */
const MAX_SCOPE_IDS = 500

/**
 * Check a key's scope against the database and throw when any named source is unusable.
 *
 * Returns the list of problems instead of throwing when `dryRun` is set, so the admin UI can warn an
 * operator BEFORE saving a scope that would immediately break — a key that cannot be used is worse
 * than one that is refused at creation.
 */
export async function validateKeyScopeSources(
  scope: KeyScope,
  opts: { dryRun?: boolean } = {},
): Promise<string[]> {
  const problems: string[] = []

  const integrationIds = scope.allowedIntegrationIds.slice(0, MAX_SCOPE_IDS)
  const documentIds = scope.allowedDocumentIds.slice(0, MAX_SCOPE_IDS)

  if (integrationIds.length > 0) {
    // Integrations and REST connectors share the scope field but live in separate tables, so both
    // are resolved and a name counts as present in EITHER. Looking only at `Integration` would
    // report every REST-scoped key as broken.
    const [integrations, connectors] = await Promise.all([
      db.integration.findMany({
        where: { id: { in: integrationIds } },
        select: { id: true, name: true, status: true },
      }),
      db.restApiConnector.findMany({
        where: { id: { in: integrationIds } },
        select: { id: true, name: true, isActive: true },
      }),
    ])

    const usable = new Set<string>()
    for (const i of integrations) {
      // `status` is a string column with `active | inactive | error`. Only `active` is usable: an
      // integration in `error` state would fail the request anyway, and failing HERE says why.
      if (i.status === 'active') usable.add(i.id)
    }
    for (const c of connectors) {
      if (c.isActive) usable.add(c.id)
    }

    const missing = integrationIds.filter((id) => !usable.has(id))
    if (missing.length > 0) {
      // Report a NAME where one is known, an id otherwise. An operator acts on names, but a
      // dangling id that resolves to nothing can only be reported as itself.
      const nameById = new Map<string, string>()
      for (const r of [...integrations, ...connectors]) nameById.set(r.id, r.name)
      const labels = missing.map((id) => nameById.get(id) ?? id)
      problems.push(
        `${labels.length === 1 ? 'Source' : 'Sources'} no longer available: ${labels.join(', ')}`,
      )
    }
  }

  if (documentIds.length > 0) {
    const docs = await db.document.findMany({
      where: { id: { in: documentIds } },
      select: { id: true, name: true, status: true, isEnabled: true },
    })
    const usable = new Set(docs.filter((d) => d.status === 'ready' && d.isEnabled).map((d) => d.id))
    const missing = documentIds.filter((id) => !usable.has(id))
    if (missing.length > 0) {
      const names = docs.filter((d) => missing.includes(d.id)).map((d) => d.name)
      const labels = missing.map((id) => docs.find((d) => d.id === id)?.name ?? id)
      problems.push(
        `${labels.length === 1 ? 'Document' : 'Documents'} no longer available: ${labels.join(', ')}`,
      )
    }
  }

  if (problems.length > 0 && !opts.dryRun) {
    throw new ScopeSourceMissingError(
      `This API key is scoped to sources that no longer exist or are not usable. ${problems.join('; ')}. ` +
        `Ask an administrator to update the key's scope.`,
    )
  }

  return problems
}

/** Convenience for the admin UI: does this scope resolve cleanly right now? */
export async function describeScopeProblems(scope: KeyScope): Promise<string | null> {
  const problems = await validateKeyScopeSources(scope, { dryRun: true })
  return problems.length > 0 ? `${problems.join('; ')} — ${describeScope(scope)}` : null
}
