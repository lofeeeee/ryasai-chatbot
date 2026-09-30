import { describe, expect, test, mock, beforeEach } from 'bun:test'

// ---------------------------------------------------------------------------
// llm-config: the BYOK credential resolution path.
//
// A separate file from llm-config.test.ts, which imports only the pure helpers
// (isBlockedHost, normalizeBaseUrl) and holds no mocks. This file owns the mocks
// for the database-backed resolvers.
//
// Why this path is security-relevant, not just plumbing: ryasai ships no LLM.
// Every org supplies its OWN endpoint, key and model, and `getLlmRuntimeConfig`
// is the single place those credentials are read. With no org context,
// `findFirst()` scans the whole table and returns whichever tenant's row happens
// to be first — a different org's baseUrl, model AND API key. The guard against
// that is what most of these tests hold.
// ---------------------------------------------------------------------------
const state = {
  orgContext: 'org-1' as string | undefined,
  rows: [] as any[],
  findFirstCalls: [] as any[],
  decryptThrows: false,
  decrypted: { apiKey: 'sk-secret' } as any,
  rand: 0,
}

mock.module('@/lib/prisma-tenant', () => ({
  getOrgContext: () => state.orgContext,
  enterWithOrg: () => {},
  bypassOrg: (fn: () => unknown) => fn(),
}))
mock.module('@/lib/db', () => ({
  db: {
    llmConfig: {
      findFirst: async (a?: any) => {
        state.findFirstCalls.push(a ?? null)
        // Honours `where: { purpose }` so the purpose-scoped queries are asserted
        // on behaviour rather than on the shape of the call.
        if (a?.where?.purpose) return state.rows.find((r) => r.purpose === a.where.purpose) ?? null
        return state.rows[0] ?? null
      },
    },
  },
}))
mock.module('@/lib/crypto', () => ({
  decryptConfig: () => {
    if (state.decryptThrows) throw new Error('bad tag')
    return state.decrypted
  },
  encryptConfig: (c: any) => `enc:${JSON.stringify(c)}`,
  signSession: () => 'tok',
  verifySession: () => null,
}))

import {
  getLlmRuntimeConfig,
  getAgentLlmConfig,
  getRoleLlmConfig,
  invalidateRoleConfigCache,
  getPublicLlmConfig,
  fetchProviderModels,
  maskSecret,
  resolveConfiguredEmbeddingModel,
  getMemoryLlmConfig,
  resolveMemoryConfigRow,
} from './llm-config'
// The fallback asserted below is a PRODUCTION value, not a test fixture. Pinning
// a copied string lets the assertion and the code drift apart silently: this test
// used to spell `text-embedding-3-small`, which was exactly the 1536-dim default
// that made every stored 384-dim chunk incomparable (retrieval compares
// `chunk.embeddingModel === queryEmbedding.model`, so similarity was always 0).
// Importing the constant means the assertion cannot outlive the fix.
import { DEFAULT_EMBEDDING_MODEL } from '@/lib/constants'

const row = (o: Record<string, unknown> = {}) => ({
  id: 'c1', provider: 'OPENAI_COMPATIBLE', baseUrl: 'https://api.own/v1',
  encryptedApiKey: 'enc-key', model: 'own-model', purpose: 'chat',
  availableModels: null, lastModelSyncAt: null, embeddingProvider: null,
  embeddingBaseUrl: null, embeddingModel: null, encryptedEmbeddingApiKey: null,
  embeddingAvailableModels: null, lastEmbeddingModelSyncAt: null,
  updatedAt: new Date('2026-01-01T00:00:00Z'),
  ...o,
})

beforeEach(() => {
  state.orgContext = 'org-1'
  state.rows = [row()]
  state.findFirstCalls = []
  state.decryptThrows = false
  state.decrypted = { apiKey: 'sk-secret' }
  invalidateRoleConfigCache()
})

describe('getLlmRuntimeConfig — the credential read', () => {
  test('NO ORG CONTEXT returns null instead of reading another tenant row', async () => {
    state.orgContext = undefined
    // This is the whole guard. Without it findFirst() scans the whole table and
    // returns whichever org's row is first — and the caller then spends a
    // stranger's API key. Proven at runtime in trial/55.
    expect(await getLlmRuntimeConfig()).toBeNull()
    expect(state.findFirstCalls).toHaveLength(0)
  })

  test('the same guard applies to the agent config', async () => {
    state.orgContext = undefined
    expect(await getAgentLlmConfig()).toBeNull()
    expect(state.findFirstCalls).toHaveLength(0)
  })

  test('resolves the purpose=chat row first', async () => {
    state.rows = [row({ purpose: 'agent', model: 'agent-model' }), row({ purpose: 'chat', model: 'chat-model' })]
    const cfg = await getLlmRuntimeConfig()
    expect(cfg?.model).toBe('chat-model')
  })

  test('falls back to any row when no purpose=chat row exists', async () => {
    state.rows = [row({ purpose: 'agent', model: 'only-agent' })]
    const cfg = await getLlmRuntimeConfig()
    expect(cfg?.model).toBe('only-agent')
  })

  test('no row at all resolves to null (fail-closed, never a platform key)', async () => {
    state.rows = []
    expect(await getLlmRuntimeConfig()).toBeNull()
  })

  test('the API key is decrypted for use and never returned masked', async () => {
    const cfg = await getLlmRuntimeConfig()
    // The runtime config feeds outbound HTTP; it needs the real key.
    expect(cfg?.apiKey).toBe('sk-secret')
  })

  test('an undecryptable key throws rather than returning a usable config', async () => {
    state.decryptThrows = true
    // Returning a config with a garbage key would fail later at the provider with
    // a misleading auth error.
    await expect(getLlmRuntimeConfig()).rejects.toThrow()
  })

  test('a decrypted blob with no apiKey is refused', async () => {
    state.decrypted = { somethingElse: 1 }
    await expect(getLlmRuntimeConfig()).rejects.toThrow('Invalid LLM API key')
  })

  test('a whitespace-only decrypted key is refused', async () => {
    state.decrypted = { apiKey: '   ' }
    await expect(getLlmRuntimeConfig()).rejects.toThrow('Invalid LLM API key')
  })
})

describe('getAgentLlmConfig — agent-purpose resolution', () => {
  test('prefers the purpose=agent row when present', async () => {
    state.rows = [row({ purpose: 'chat', model: 'chat-model' }), row({ purpose: 'agent', model: 'agent-model' })]
    expect((await getAgentLlmConfig())?.model).toBe('agent-model')
  })

  test('falls back to the chat config when no agent row is configured', async () => {
    state.rows = [row({ purpose: 'chat', model: 'chat-model' })]
    expect((await getAgentLlmConfig())?.model).toBe('chat-model')
  })

  test('agent config is org-guarded on the fallback path too', async () => {
    state.orgContext = undefined
    state.rows = []
    expect(await getAgentLlmConfig()).toBeNull()
  })
})

describe('getRoleLlmConfig — the cache is per ORG, not per process', () => {
  /**
   * CROSS-TENANT LEAK, measured before the fix.
   *
   * `_roleCache` was `Map<LlmRole, ...>` — one entry per role for the WHOLE PROCESS. With two orgs
   * holding different configs the resolution was: org-A got `https://a.example/v1`, and then org-B ALSO
   * got org A's endpoint and API key, for up to the 30s TTL. `getLlmRuntimeConfig` refuses to read
   * without an org context, but this cache short-circuited AHEAD of that guard, so the protection never
   * applied to the role path. Every caller of `getRoleLlmConfig` was exposed: intent-pipeline, hyde,
   * knowledge-graph, rag rerank, embeddings, alignment-check, reflection, simple-pipeline, source-init.
   */
  test('a config cached for one org is NOT served to another', async () => {
    state.rows = [row({ purpose: 'chat', baseUrl: 'https://a.example/v1', model: 'model-A' })]
    state.orgContext = 'org-A'
    const first = await getRoleLlmConfig('extract')
    expect(first?.baseUrl).toBe('https://a.example/v1')

    // A DIFFERENT ORG with its own row. Without the org in the cache key this returned org A's endpoint
    // from cache and never touched the database.
    state.rows = [row({ purpose: 'chat', baseUrl: 'https://b.example/v1', model: 'model-B' })]
    state.orgContext = 'org-B'
    const second = await getRoleLlmConfig('extract')
    expect(second?.baseUrl).toBe('https://b.example/v1')
    expect(second?.model).toBe('model-B')
  })

  test('the SAME org still hits its own cache — the fix must not disable caching', async () => {
    // The opposite direction. Keying by org is only correct if it still caches within one org, or the
    // isolation would have been bought by removing the feature.
    state.rows = [row({ purpose: 'chat', baseUrl: 'https://a.example/v1' })]
    state.orgContext = 'org-A'
    await getRoleLlmConfig('extract')
    const afterFirst = state.findFirstCalls.length
    await getRoleLlmConfig('extract')
    expect(state.findFirstCalls.length).toBe(afterFirst)
  })

  test('no org context means NO cache: the read is refused, not shared', async () => {
    // A cache entry created under a real org must not be reachable from a context-less call, which is the
    // shape `bypassOrg` produces in background work.
    state.rows = [row({ purpose: 'chat', baseUrl: 'https://a.example/v1' })]
    state.orgContext = 'org-A'
    await getRoleLlmConfig('extract')

    state.orgContext = undefined
    expect(await getRoleLlmConfig('extract')).toBeNull()
  })
})

describe('getRoleLlmConfig — role overrides with cache', () => {
  test('chat and agent roles delegate to their resolvers', async () => {
    state.rows = [row({ purpose: 'chat', model: 'chat-model' })]
    expect((await getRoleLlmConfig('chat'))?.model).toBe('chat-model')
  })

  test('a role-specific row wins for that role', async () => {
    state.rows = [row({ purpose: 'query', model: 'query-model' }), row({ purpose: 'chat', model: 'chat-model' })]
    expect((await getRoleLlmConfig('query'))?.model).toBe('query-model')
  })

  test('a role with no row falls back to the chat config (opt-in)', async () => {
    state.rows = [row({ purpose: 'chat', model: 'chat-model' })]
    expect((await getRoleLlmConfig('keyword'))?.model).toBe('chat-model')
  })

  test('the second read is served from cache, not the database', async () => {
    state.rows = [row({ purpose: 'chat' })]
    await getRoleLlmConfig('extract')
    const afterFirst = state.findFirstCalls.length
    await getRoleLlmConfig('extract')
    // Caching is the point of this layer; without it every extraction request
    // re-reads config.
    expect(state.findFirstCalls.length).toBe(afterFirst)
  })

  test('invalidateRoleConfigCache forces a fresh read', async () => {
    state.rows = [row({ purpose: 'chat' })]
    await getRoleLlmConfig('extract')
    const afterFirst = state.findFirstCalls.length
    invalidateRoleConfigCache()
    await getRoleLlmConfig('extract')
    expect(state.findFirstCalls.length).toBeGreaterThan(afterFirst)
  })

  test('chat/agent roles are not cached, so a config change is seen immediately', async () => {
    state.rows = [row({ purpose: 'chat' })]
    await getRoleLlmConfig('chat')
    const n = state.findFirstCalls.length
    await getRoleLlmConfig('chat')
    expect(state.findFirstCalls.length).toBeGreaterThan(n)
  })
})

describe('getPublicLlmConfig — what reaches the browser', () => {
  test('an unconfigured org reports configured:false with empty defaults', async () => {
    state.rows = []
    const pub = await getPublicLlmConfig()
    expect(pub.configured).toBe(false)
    expect(pub.apiKeyMasked).toBeNull()
    expect(pub.baseUrl).toBe('')
  })

  test('THE API KEY IS MASKED, never returned in clear text', async () => {
    state.decrypted = { apiKey: 'sk-live-abcdef123456' }
    const pub = await getPublicLlmConfig()
    // A clear key in this payload hands every credential to the browser.
    expect(pub.apiKeyMasked).not.toBe('sk-live-abcdef123456')
    expect(pub.apiKeyMasked).toContain('•')
    expect(JSON.stringify(pub)).not.toContain('sk-live-abcdef123456')
  })

  test('a decryption failure shows a placeholder mask, not the ciphertext', async () => {
    state.decryptThrows = true
    const pub = await getPublicLlmConfig()
    // Degrading here must not leak enc:... or crash the settings page.
    expect(pub.apiKeyMasked).toBe('••••')
  })

  test('the embedding key is masked independently of the chat key', async () => {
    state.rows = [row({ encryptedEmbeddingApiKey: 'enc-emb' })]
    state.decrypted = { apiKey: 'sk-live-abcdef123456' }
    const pub = await getPublicLlmConfig()
    expect(pub.embeddingApiKeyMasked).not.toBeNull()
    expect(pub.embeddingApiKeyMasked).toContain('•')
  })

  test('a failed embedding key decryption does not break the whole payload', async () => {
    state.rows = [row({ encryptedEmbeddingApiKey: 'enc-emb' })]
    state.decryptThrows = true
    const pub = await getPublicLlmConfig()
    expect(pub.configured).toBe(true)
    expect(pub.embeddingApiKeyMasked).toBe('••••')
  })

  test('no embedding key configured leaves the mask null', async () => {
    state.rows = [row({ encryptedEmbeddingApiKey: null })]
    expect((await getPublicLlmConfig()).embeddingApiKeyMasked).toBeNull()
  })

  test('embedding settings fall back to the chat endpoint and the packaged model', async () => {
    const pub = await getPublicLlmConfig()
    // Most orgs run one endpoint for both; empty boxes would look unconfigured.
    // The MODEL half is different: it must fall back to the model this build
    // actually ships and stamps onto chunks, not to an OpenAI id, because the
    // stored vectors are 384-dimensional and retrieval refuses to compare a
    // chunk whose stamp differs from the query embedding's model.
    expect(pub.embeddingBaseUrl).toBe('https://api.own/v1')
    expect(pub.embeddingModel).toBe(DEFAULT_EMBEDDING_MODEL)
  })

  test('an explicitly set embedding endpoint overrides the chat one', async () => {
    state.rows = [row({ embeddingBaseUrl: 'https://emb.own/v1', embeddingModel: 'emb-x' })]
    const pub = await getPublicLlmConfig()
    expect(pub.embeddingBaseUrl).toBe('https://emb.own/v1')
    expect(pub.embeddingModel).toBe('emb-x')
  })

  test('the model list is parsed from JSON and a corrupt value yields []', async () => {
    state.rows = [row({ availableModels: '["a","b"]' })]
    expect((await getPublicLlmConfig()).availableModels).toEqual(['a', 'b'])
    state.rows = [row({ availableModels: 'not json' })]
    expect((await getPublicLlmConfig()).availableModels).toEqual([])
  })

  test('sync timestamps are serialised as ISO strings, not Date objects', async () => {
    state.rows = [row({ lastModelSyncAt: new Date('2026-02-02T00:00:00Z') })]
    const pub = await getPublicLlmConfig()
    expect(typeof pub.lastModelSyncAt).toBe('string')
    expect(pub.lastModelSyncAt).toBe('2026-02-02T00:00:00.000Z')
    expect(typeof pub.updatedAt).toBe('string')
  })
})

describe('resolveConfiguredEmbeddingModel — the model a query would be embedded with', () => {
  /*
   * The other half of the Knowledge → External Vector DB warning. `DocumentChunk.embeddingModel` records what the
   * STORED vectors were built with; this resolver is what the CURRENT config would send as the request's `model`.
   * `retrieveRelevantChunks` gates every chunk on those two strings being EQUAL, so a wrong answer here is not a
   * cosmetic bug: it either hides a real mismatch (reporting a healthy embedding on an install where every
   * semantic score is 0) or invents one (sending an operator to re-embed data that was fine).
   */

  test('an explicitly configured model is returned verbatim', async () => {
    state.rows = [row({ embeddingModel: 'bge-m3' })]
    expect(await resolveConfiguredEmbeddingModel()).toBe('bge-m3')
  })

  test('a BLANK stored model resolves to the packaged model, not to a provider default', async () => {
    /*
     * This is the fix-#4 expression, asserted through its new caller. A blank box used to resolve to an OpenAI
     * model of a different width, which the embedder sent as the request `model` AND stamped onto every new chunk
     * — beside a `vector(384)` column. The exact same fallback must apply here, or the panel would compare the
     * stored stamp against a string the write path would never produce.
     */
    state.rows = [row({ embeddingModel: '' })]
    expect(await resolveConfiguredEmbeddingModel()).toBe(DEFAULT_EMBEDDING_MODEL)
  })

  test('a WHITESPACE-ONLY stored model is treated as unset', async () => {
    // `??` alone would leave '   ' here: a truthy string that is not a model name, which the panel would then
    // compare against a real stamp and report as a mismatch for a config that has nothing in it.
    state.rows = [row({ embeddingModel: '   ' })]
    expect(await resolveConfiguredEmbeddingModel()).toBe(DEFAULT_EMBEDDING_MODEL)
  })

  test('a NULL stored model is treated as unset', async () => {
    state.rows = [row({ embeddingModel: null })]
    expect(await resolveConfiguredEmbeddingModel()).toBe(DEFAULT_EMBEDDING_MODEL)
  })

  test('NO config row returns null — "cannot tell", never the packaged default', async () => {
    /*
     * The distinction the UI keys off. With no row there is nothing configured, so answering with the packaged
     * model would be an INVENTED fact: the panel would compare the stored stamp against a model this install does
     * not actually use and render the result as a verdict. Null instead makes the server report 'unknown', which
     * renders as "cannot tell".
     */
    state.rows = []
    expect(await resolveConfiguredEmbeddingModel()).toBeNull()
  })

  test('NO ORG CONTEXT returns null instead of reading another tenant row', async () => {
    // Same guard the credential path holds: without it `findFirst()` scans the whole table and the model of
    // whichever tenant sorts first becomes this panel's comparison basis.
    state.orgContext = undefined
    state.rows = [row({ embeddingModel: 'another-orgs-model' })]
    expect(await resolveConfiguredEmbeddingModel()).toBeNull()
  })

  test('it reads the PURPOSE-scoped row, so it cannot disagree with what a save writes', async () => {
    /*
     * This install has two rows. The screen WRITES through `findFirst({ where: { purpose: 'chat' } })`; a bare
     * `findFirst()` here could read the other row and compare the chunks against a model that is never used for
     * embedding — a mismatch reported against a config the operator cannot even edit there.
     */
    state.rows = [
      row({ purpose: 'agent', embeddingModel: 'agent-row-model' }),
      row({ purpose: 'chat', embeddingModel: 'chat-row-model' }),
    ]
    expect(await resolveConfiguredEmbeddingModel()).toBe('chat-row-model')
    expect(state.findFirstCalls[0]).toMatchObject({ where: { purpose: 'chat' } })
  })
})

describe('fetchProviderModels', () => {
  const originalFetch = global.fetch
  test('requires an API key before making any request', async () => {
    let called = false
    global.fetch = (async () => { called = true; return { ok: true, json: async () => ({}) } }) as any
    await expect(fetchProviderModels({ baseUrl: 'https://x/v1', apiKey: '  ' })).rejects.toThrow('API key is required')
    expect(called).toBe(false)
    global.fetch = originalFetch
  })

  test('reads both OpenAI `data` and legacy `models` shapes, deduped and sorted', async () => {
    global.fetch = (async () => ({
      ok: true,
      json: async () => ({ data: [{ id: 'b' }, { id: 'a' }], models: ['a', { id: 'c' }, { name: 'd' }, 42] }),
    })) as any
    const models = await fetchProviderModels({ baseUrl: 'https://x/v1', apiKey: 'k' })
    // Providers differ here; missing one shape makes the model picker empty.
    expect(models).toEqual(['a', 'b', 'c', 'd'])
    global.fetch = originalFetch
  })

  test('a non-2xx response throws the CLASSIFIED error, not a bare status', async () => {
    // This is the first feedback a customer's pasted credential ever gets — "sync models" is the
    // button they press after typing a key. It used to throw `Failed to fetch models (HTTP 401)`
    // and never read the response body, so `classifyProviderFailure` could not run and the
    // actionable hint ("re-enter the key", "add credit", "pick a model your provider serves") was
    // unreachable on this path even though `toTypedError` already forwards `hint` to the client.
    const original = global.fetch
    global.fetch = (async () => ({
      ok: false,
      status: 401,
      text: async () => JSON.stringify({ error: { message: 'Incorrect API key provided: sk-abc***' } }),
    })) as any
    const { toTypedError } = await import('@/lib/errors')
    let typed: ReturnType<typeof toTypedError> | null = null
    try {
      await fetchProviderModels({ baseUrl: 'https://x/v1', apiKey: 'k' })
    } catch (e) {
      typed = toTypedError(e)
    }
    global.fetch = original

    expect(typed).not.toBeNull()
    expect(typed!.code).toBe('LLM_ERROR')
    // The customer must be told WHAT to do, not just that something failed.
    expect(typed!.hint).toContain('rejected the API key')
    // And the provider body must not leak the key prefix.
    expect(JSON.stringify(typed)).not.toContain('sk-abc')
  })

  test('a quota failure is classified differently from a bad key', async () => {
    const original = global.fetch
    global.fetch = (async () => ({
      ok: false,
      status: 429,
      text: async () => 'insufficient_quota: you exceeded your current quota',
    })) as any
    const { toTypedError } = await import('@/lib/errors')
    let typed: ReturnType<typeof toTypedError> | null = null
    try {
      await fetchProviderModels({ baseUrl: 'https://x/v1', apiKey: 'k' })
    } catch (e) {
      typed = toTypedError(e)
    }
    global.fetch = original
    // Distinct from the auth hint: this one is about the customer's provider balance.
    expect(typed!.hint).toContain('out of credit')
    expect(typed!.message).toContain('quota')
  })

  test('the key is sent as a Bearer token to the normalised /models URL', async () => {
    let seen: any = null
    global.fetch = (async (url: string, init: any) => {
      seen = { url, init }
      return { ok: true, json: async () => ({ data: [] }) }
    }) as any
    await fetchProviderModels({ baseUrl: 'https://x/v1/', apiKey: ' k ' })
    expect(seen.url).toBe('https://x/v1/models')
    expect(seen.init.headers.Authorization).toBe('Bearer k')
    global.fetch = originalFetch
  })

  test('an entries-less payload yields an empty list rather than throwing', async () => {
    global.fetch = (async () => ({ ok: true, json: async () => ({}) })) as any
    expect(await fetchProviderModels({ baseUrl: 'https://x/v1', apiKey: 'k' })).toEqual([])
    global.fetch = originalFetch
  })
})

describe('maskSecret', () => {
  test('never returns the original string', () => {
    const secret = 'sk-live-abcdef123456'
    expect(maskSecret(secret)).not.toBe(secret)
    expect(maskSecret(secret)).toContain('•')
  })

  test('keeps a recognisable head so an operator can tell keys apart', () => {
    const masked = maskSecret('sk-live-abcdef123456')
    expect(masked.startsWith('sk-l')).toBe(true)
  })
})

/**
 * AI Memory's OWN provider row — the feature that lets extraction use a different model than answering.
 *
 * THE FALLBACK IS THE WHOLE RISK. Every install that upgrades into this feature has no `purpose:
 * 'memory'` row and its memory works today. So "no memory row" must resolve to the CHAT credentials,
 * not to null: a null here reads as "memory is unconfigured" and silently stops extraction on
 * installs that were fine. `source` exists so a caller can tell the two states apart rather than
 * assuming, which is what makes the feature visible on an install that has not used it yet.
 */
describe('getMemoryLlmConfig — memory may have its own model, and follows chat when it does not', () => {
  test('a dedicated memory row wins over chat, and is reported as the source', async () => {
    state.rows = [
      row({ purpose: 'chat', model: 'chat-model', baseUrl: 'https://chat.example/v1' }),
      row({ purpose: 'memory', model: 'memory-model', baseUrl: 'https://memory.example/v1' }),
    ]
    const cfg = await getMemoryLlmConfig()
    expect(cfg?.model).toBe('memory-model')
    expect(cfg?.baseUrl).toBe('https://memory.example/v1')
    expect(cfg?.source).toBe('memory')
  })

  test('NO memory row falls back to chat rather than to null', async () => {
    // The upgrade case, and the reason this test exists: returning null would stop memory writes on
    // every install that never opened the new screen.
    state.rows = [row({ purpose: 'chat', model: 'chat-model' })]
    const cfg = await getMemoryLlmConfig()
    expect(cfg).not.toBeNull()
    expect(cfg?.model).toBe('chat-model')
    expect(cfg?.source).toBe('chat')
  })

  test('the memory row is read by PURPOSE, so it cannot pick up the agent or role rows', async () => {
    // `purpose` is the only discriminator on this table. An unscoped findFirst would return whichever
    // row the planner happened to sort first — the exact defect the chat resolver documents.
    state.rows = [
      row({ purpose: 'agent', model: 'agent-model' }),
      row({ purpose: 'chat', model: 'chat-model' }),
    ]
    expect((await getMemoryLlmConfig())?.model).toBe('chat-model')
    expect(state.findFirstCalls[0]).toMatchObject({ where: { purpose: 'memory' } })
  })

  test('NO ORG CONTEXT resolves null, and never reads another tenant\'s memory row', async () => {
    state.orgContext = undefined
    state.rows = [row({ purpose: 'memory', model: 'another-org-model' })]
    expect(await resolveMemoryConfigRow()).toBeNull()
    expect(await getMemoryLlmConfig()).toBeNull()
  })

  test('with no config at all it resolves null — "cannot tell", never a fabricated model', async () => {
    state.rows = []
    expect(await getMemoryLlmConfig()).toBeNull()
    expect(await resolveMemoryConfigRow()).toBeNull()
  })

  test('a memory row with an undecryptable key throws rather than silently falling back to chat', async () => {
    /*
     * Deliberately NOT a fallback. An operator who saved a memory provider and then had decryption
     * fail must see an error: quietly extracting with the CHAT key instead would bill a different
     * account and hide a broken credential — and the user would have no way to notice, because the
     * screen would show the memory row they saved.
     */
    state.rows = [row({ purpose: 'memory', model: 'memory-model' })]
    state.decryptThrows = true
    await expect(getMemoryLlmConfig()).rejects.toThrow()
  })
})
