import { describe, expect, test } from 'bun:test'

import {
  API_KEY_TOOLS,
  describeScope,
  isApiKeyTool,
  readKeyScope,
  resolveScope,
  scopeAllowsTool,
  ScopeDeniedError,
} from './api-key-scope'

/**
 * Source scoping semantics.
 *
 * The tests below pin BOTH directions of the empty-means-all convention. It is a one-character
 * change to invert, it would silently revoke every existing key's access on deploy, and the symptom
 * (a previously working integration returning "not allowed") looks like a client bug rather than a
 * server convention.
 */
describe('api key scope — reading a stored key', () => {
  test('absent or null columns resolve to unrestricted, not to denied', () => {
    // A row loaded before the migration, or a test double that omits the field, must not lock anyone
    // out. Throwing here would turn a missing column into an auth failure.
    for (const row of [{}, { allowedIntegrationIds: null, allowedDocumentIds: null, allowedTools: null }]) {
      const s = readKeyScope(row as never)
      expect(s.allowedIntegrationIds).toEqual([])
      expect(s.allowedDocumentIds).toEqual([])
      expect(s.allowedTools).toEqual([])
      expect(resolveScope(s)).toEqual({ integrationIds: null, documentIds: null, tools: null })
    }
  })

  test('blanks and duplicates are dropped, order preserved', () => {
    const s = readKeyScope({
      allowedIntegrationIds: ['b', 'a', 'b', '', '  '],
      allowedDocumentIds: ['d1', ' d1 '],
      allowedTools: ['RAG', 'RAG'],
    })
    expect(s.allowedIntegrationIds).toEqual(['b', 'a'])
    expect(s.allowedDocumentIds).toEqual(['d1'])
    expect(s.allowedTools).toEqual(['RAG'])
  })

  test('unknown tool names are discarded rather than stored', () => {
    // A typo must not become a tool nobody can use; it should simply not be granted.
    const s = readKeyScope({ allowedTools: ['RAG', 'EXECUTE_SHELL', 'sql'] })
    expect(s.allowedTools).toEqual(['RAG'])
    expect(API_KEY_TOOLS).toContain('SQL')
  })

  test('isApiKeyTool rejects non-strings and near-misses', () => {
    expect(isApiKeyTool('SQL')).toBe(true)
    expect(isApiKeyTool('sql')).toBe(false)
    expect(isApiKeyTool(null)).toBe(false)
    expect(isApiKeyTool(1)).toBe(false)
  })
})

describe('api key scope — resolving a request', () => {
  const restricted = readKeyScope({
    allowedIntegrationIds: ['erp', 'crm'],
    allowedDocumentIds: ['doc-1'],
    allowedTools: ['RAG', 'CHAT'],
  })

  test('an unrestricted key accepts any subset the client asks for', () => {
    // A client may narrow its OWN access; it can never exceed the key.
    const open = readKeyScope({})
    expect(resolveScope(open, { integrationIds: ['anything'] })).toEqual({
      integrationIds: ['anything'],
      documentIds: null,
      tools: null,
    })
  })

  test('a restricted key accepts a subset of what it allows', () => {
    const eff = resolveScope(restricted, { integrationIds: ['erp'], documentIds: ['doc-1'] })
    expect(eff.integrationIds).toEqual(['erp'])
    expect(eff.documentIds).toEqual(['doc-1'])
  })

  test('a request naming an allowed source keeps the REST of the key scope intact', () => {
    // Narrowing the integration must not widen documents: the tools list stays from the key.
    const eff = resolveScope(restricted, { integrationIds: ['erp'] })
    expect(eff.documentIds).toEqual(['doc-1'])
    expect(eff.tools).toEqual(['RAG', 'CHAT'])
  })

  test('a request OUTSIDE the scope is REJECTED, not silently narrowed', () => {
    // The load-bearing behaviour. Silently dropping "crm" would answer a question about CRM from
    // whatever else was allowed — a confident answer to a question nobody asked.
    expect(() => resolveScope(restricted, { integrationIds: ['crm', 'payroll'] })).toThrow(ScopeDeniedError)
    try {
      resolveScope(restricted, { integrationIds: ['payroll'] })
      throw new Error('should have thrown')
    } catch (e) {
      expect(e).toBeInstanceOf(ScopeDeniedError)
      // The message must name WHAT was refused, or an operator cannot act on it.
      expect((e as Error).message).toContain('payroll')
      expect((e as Error).message).toMatch(/not allowed/i)
    }
  })

  test('a denied document is rejected too, and names the document', () => {
    try {
      resolveScope(restricted, { documentIds: ['doc-999'] })
      throw new Error('should have thrown')
    } catch (e) {
      expect(e).toBeInstanceOf(ScopeDeniedError)
      expect((e as Error).message).toContain('doc-999')
    }
  })

  test('no request and no key restriction yields null on every axis', () => {
    expect(resolveScope(readKeyScope({}))).toEqual({
      integrationIds: null,
      documentIds: null,
      tools: null,
    })
  })

  test('an empty request leaves the key restriction in place', () => {
    expect(resolveScope(restricted)).toEqual({
      integrationIds: ['erp', 'crm'],
      documentIds: ['doc-1'],
      tools: ['RAG', 'CHAT'],
    })
  })
})

describe('api key scope — tool families', () => {
  test('null tools allows everything; a list allows only itself', () => {
    expect(scopeAllowsTool({ integrationIds: null, documentIds: null, tools: null }, 'SQL')).toBe(true)
    const ragOnly = { integrationIds: null, documentIds: null, tools: ['RAG' as const] }
    expect(scopeAllowsTool(ragOnly, 'RAG')).toBe(true)
    expect(scopeAllowsTool(ragOnly, 'SQL')).toBe(false)
    // Case matters: the router emits uppercase, so a lowercase entry grants nothing and that
    // mismatch must be visible rather than accidentally permissive.
    expect(scopeAllowsTool(ragOnly, 'rag')).toBe(false)
  })
})

describe('api key scope — describing it for the key list', () => {
  test('an unrestricted key says so explicitly', () => {
    // A blank cell would read as "no access configured" and be over- or under-trusted.
    expect(describeScope(readKeyScope({}))).toBe('All sources')
  })

  test('a restricted key counts what it allows and never prints ids', () => {
    const s = describeScope(readKeyScope({ allowedIntegrationIds: ['erp'], allowedDocumentIds: ['d1', 'd2'], allowedTools: ['RAG'] }))
    expect(s).toContain('1 source')
    expect(s).toContain('2 documents')
    expect(s).toContain('RAG')
    // Ids in a list cell would be unreadable and could leak internal identifiers into a screenshot.
    expect(s).not.toContain('erp')
    expect(s).not.toContain('d1')
  })

  test('singular and plural are both handled', () => {
    expect(describeScope(readKeyScope({ allowedDocumentIds: ['a'] }))).toContain('1 document')
    expect(describeScope(readKeyScope({ allowedDocumentIds: ['a', 'b'] }))).toContain('2 documents')
  })
})
