import { beforeEach, describe, expect, mock, test } from 'bun:test'

import { readKeyScope } from './api-key-scope'

/**
 * Fail-closed source validation (decision A).
 *
 * A key scoped to a source that no longer exists or is no longer usable must REFUSE requests, not
 * answer from whatever remains. The alternative — silently narrowing — produces a confident answer
 * built from sources the operator did not choose, which is the failure mode `resolveScope` already
 * refuses one level up.
 */
const state = {
  integrations: [] as Array<{ id: string; name: string; status: string }>,
  connectors: [] as Array<{ id: string; name: string; isActive: boolean }>,
  documents: [] as Array<{ id: string; name: string; status: string; isEnabled: boolean }>,
}

mock.module('@/lib/db', () => ({
  db: {
    integration: { findMany: async (a: { where: { id: { in: string[] } } }) => state.integrations.filter((i) => a.where.id.in.includes(i.id)) },
    restApiConnector: { findMany: async (a: { where: { id: { in: string[] } } }) => state.connectors.filter((c) => a.where.id.in.includes(c.id)) },
    document: { findMany: async (a: { where: { id: { in: string[] } } }) => state.documents.filter((d) => a.where.id.in.includes(d.id)) },
  },
}))

const { ScopeSourceMissingError, describeScopeProblems, validateKeyScopeSources } = await import(
  './api-key-scope-guard'
)

beforeEach(() => {
  state.integrations = []
  state.connectors = []
  state.documents = []
})

describe('scope source validation — an unrestricted key is never checked or refused', () => {
  test('an empty scope passes without querying anything', async () => {
    // THE load-bearing case for "empty means all": every key created before this feature has empty
    // arrays. If validation treated empty as "resolve nothing", every existing key would start
    // failing the moment this shipped.
    const problems = await validateKeyScopeSources(readKeyScope({}), { dryRun: true })
    expect(problems).toEqual([])
    // And it must not throw on the enforcing path either.
    await expect(validateKeyScopeSources(readKeyScope({}))).resolves.toEqual([])
  })
})

describe('scope source validation — usable sources pass', () => {
  test('an active integration is accepted', async () => {
    state.integrations = [{ id: 'erp', name: 'ERP', status: 'active' }]
    await expect(
      validateKeyScopeSources(readKeyScope({ allowedIntegrationIds: ['erp'] })),
    ).resolves.toEqual([])
  })

  test('a ready and enabled document is accepted', async () => {
    state.documents = [{ id: 'd1', name: 'SOP.pdf', status: 'ready', isEnabled: true }]
    await expect(
      validateKeyScopeSources(readKeyScope({ allowedDocumentIds: ['d1'] })),
    ).resolves.toEqual([])
  })

  test('an ACTIVE REST connector counts, even though it is not an Integration row', async () => {
    // Both live in the same scope array but in different tables. Resolving only `Integration` would
    // report every REST-scoped key as broken, which would be a self-inflicted outage.
    state.connectors = [{ id: 'rest-1', name: 'CRM API', isActive: true }]
    await expect(
      validateKeyScopeSources(readKeyScope({ allowedIntegrationIds: ['rest-1'] })),
    ).resolves.toEqual([])
  })
})

describe('scope source validation — unusable sources REFUSE the request', () => {
  test('a deleted integration throws, and names it', async () => {
    expect.assertions(2)
    try {
      await validateKeyScopeSources(readKeyScope({ allowedIntegrationIds: ['gone'] }))
      throw new Error('should have thrown')
    } catch (e) {
      expect(e).toBeInstanceOf(ScopeSourceMissingError)
      // The message must name the source: "scope is broken" with no name gives an operator nothing.
      expect((e as Error).message).toContain('gone')
    }
  })

  test('an INACTIVE integration throws even though the row still exists', async () => {
    // Existence is not usability. A row in `error` state would fail the request anyway — failing
    // here instead says WHY, which is the whole justification for failing closed.
    state.integrations = [{ id: 'erp', name: 'ERP', status: 'error' }]
    await expect(
      validateKeyScopeSources(readKeyScope({ allowedIntegrationIds: ['erp'] })),
    ).rejects.toBeInstanceOf(ScopeSourceMissingError)
  })

  test('an inactive REST connector throws', async () => {
    state.connectors = [{ id: 'rest-1', name: 'CRM API', isActive: false }]
    await expect(
      validateKeyScopeSources(readKeyScope({ allowedIntegrationIds: ['rest-1'] })),
    ).rejects.toBeInstanceOf(ScopeSourceMissingError)
  })

  test('a document that is ready but DISABLED throws', async () => {
    state.documents = [{ id: 'd1', name: 'SOP.pdf', status: 'ready', isEnabled: false }]
    await expect(
      validateKeyScopeSources(readKeyScope({ allowedDocumentIds: ['d1'] })),
    ).rejects.toBeInstanceOf(ScopeSourceMissingError)
  })

  test('a document still PROCESSING throws', async () => {
    // Not yet searchable. Accepting it would answer from an empty candidate set and look like a
    // retrieval miss rather than a configuration problem.
    state.documents = [{ id: 'd1', name: 'New.pdf', status: 'processing', isEnabled: true }]
    await expect(
      validateKeyScopeSources(readKeyScope({ allowedDocumentIds: ['d1'] })),
    ).rejects.toBeInstanceOf(ScopeSourceMissingError)
  })

  test('ONE missing source among several valid ones still refuses', async () => {
    // The crux of decision A: answering from the remaining sources is exactly the silent narrowing
    // this refuses. The request fails so the operator learns the scope is stale.
    state.integrations = [{ id: 'erp', name: 'ERP', status: 'active' }]
    state.documents = [{ id: 'd1', name: 'SOP.pdf', status: 'ready', isEnabled: true }]
    const scope = readKeyScope({
      allowedIntegrationIds: ['erp', 'removed-db'],
      allowedDocumentIds: ['d1'],
    })
    try {
      await validateKeyScopeSources(scope)
      throw new Error('should have thrown')
    } catch (e) {
      expect(e).toBeInstanceOf(ScopeSourceMissingError)
      expect((e as Error).message).toContain('removed-db')
      // The VALID source must not be reported as a problem.
      expect((e as Error).message).not.toContain('ERP')
    }
  })

  test('the error names the source by NAME when the row still exists', async () => {
    state.integrations = [{ id: 'erp', name: 'ERP Production', status: 'inactive' }]
    try {
      await validateKeyScopeSources(readKeyScope({ allowedIntegrationIds: ['erp'] }))
      throw new Error('should have thrown')
    } catch (e) {
      expect((e as Error).message).toContain('ERP Production')
    }
  })

  test('both categories can be reported in one error', async () => {
    const scope = readKeyScope({ allowedIntegrationIds: ['gone-1'], allowedDocumentIds: ['gone-2'] })
    try {
      await validateKeyScopeSources(scope)
      throw new Error('should have thrown')
    } catch (e) {
      const msg = (e as Error).message
      expect(msg).toContain('gone-1')
      expect(msg).toContain('gone-2')
      // Tells the operator what to DO, not just what is wrong.
      expect(msg).toMatch(/administrator/i)
    }
  })
})

describe('scope source validation — dry run for the admin UI', () => {
  test('dryRun reports problems without throwing, so a bad scope can be blocked before saving', async () => {
    const problems = await validateKeyScopeSources(
      readKeyScope({ allowedIntegrationIds: ['gone'] }),
      { dryRun: true },
    )
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('gone')
  })

  test('describeScopeProblems returns null when the scope resolves', async () => {
    state.integrations = [{ id: 'erp', name: 'ERP', status: 'active' }]
    expect(await describeScopeProblems(readKeyScope({ allowedIntegrationIds: ['erp'] }))).toBeNull()
  })
})
