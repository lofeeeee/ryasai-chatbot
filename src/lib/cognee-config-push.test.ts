import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Pushing the org's provider credentials into the cognee sidecar.
 *
 * The behaviour worth testing is not "does it POST" — it is the three ways this silently fails:
 *   1. the model string lacks `openai/`, so litellm rejects it and the endpoint is never called;
 *   2. the push is one-shot, so the first sidecar restart loses it (cognee's settings are in-memory);
 *   3. the API key leaks into a result an operator can see or a log can capture.
 */
const state = {
  serverOptions: null as { baseUrl: string; timeoutMs?: number; apiKey?: string } | null,
  llmConfig: null as { id: string; provider: string; baseUrl: string; apiKey: string; model: string } | null,
  requests: [] as Array<{ url: string; body: unknown; headers: Record<string, string> }>,
  respond: (() => new Response('{}', { status: 200 })) as () => Response,
}

mock.module('@/lib/cognee-core', () => ({
  getCogneeServerOptions: async () => state.serverOptions,
}))

mock.module('@/lib/llm-config', () => ({
  getLlmRuntimeConfig: async () => state.llmConfig,
}))

mock.module('@/lib/logger', () => ({
  scopedLogger: () => ({ debug: () => {}, warn: () => {}, info: () => {}, error: () => {} }),
  log: { debug: () => {}, warn: () => {}, info: () => {}, error: () => {} },
  logSwallowed: () => {},
}))

const realFetch = globalThis.fetch
globalThis.fetch = (async (url: string, init?: RequestInit) => {
  const headers: Record<string, string> = {}
  for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) headers[k] = v
  state.requests.push({
    url: String(url),
    body: init?.body ? JSON.parse(String(init.body)) : null,
    headers,
  })
  return state.respond()
}) as unknown as typeof fetch

const { pushCogneeProviderConfig, readCogneeProviderConfig } = await import('./cognee-config-push')

beforeEach(() => {
  state.serverOptions = { baseUrl: 'http://cognee:8000' }
  state.llmConfig = {
    id: 'c1',
    provider: 'OPENAI_COMPATIBLE',
    baseUrl: 'https://proxy.example/v1',
    apiKey: 'sk-secret-value',
    model: 'cbcn/deepseek-v4.1-flash',
  }
  state.requests = []
  state.respond = () => new Response('{}', { status: 200 })
})

describe('cognee provider push — the model string litellm understands', () => {
  test('a bare model id is prefixed with openai/', async () => {
    // THE defect this guards. cognee's litellm parses the text before the first `/` as a PROVIDER, so
    // an unprefixed id resolves to a provider that does not exist and the endpoint is never called.
    // Measured: bare -> BadRequestError "LLM Provider NOT provided"; prefixed -> dim=384.
    await pushCogneeProviderConfig()
    const body = state.requests[0].body as { llm: { model: string } }
    expect(body.llm.model).toBe('openai/cbcn/deepseek-v4.1-flash')
  })

  test('an already-prefixed model is not double-prefixed', async () => {
    state.llmConfig!.model = 'openai/gpt-4o-mini'
    await pushCogneeProviderConfig()
    const body = state.requests[0].body as { llm: { model: string } }
    expect(body.llm.model).toBe('openai/gpt-4o-mini')
  })

  test('the provider sent is ONE litellm recognises, not the app enum', async () => {
    // The app stores 'OPENAI_COMPATIBLE'. Sending that would be a provider litellm cannot resolve.
    await pushCogneeProviderConfig()
    const body = state.requests[0].body as { llm: { provider: string } }
    expect(body.llm.provider).toBe('openai')
  })

  test('the endpoint and key come from the DECRYPTED app config, not from a copy', async () => {
    await pushCogneeProviderConfig()
    const body = state.requests[0].body as { llm: { endpoint: string; apiKey: string } }
    expect(body.llm.endpoint).toBe('https://proxy.example/v1')
    expect(body.llm.apiKey).toBe('sk-secret-value')
  })

  test('it POSTs to the sidecar settings endpoint', async () => {
    await pushCogneeProviderConfig()
    expect(state.requests[0].url).toBe('http://cognee:8000/api/v1/settings')
  })
})

describe('cognee provider push — the key never escapes', () => {
  test('the key appears in the REQUEST but never in the RESULT', async () => {
    // A result is shown in a toast and written to audit logs; a request body is not. Echoing the key
    // back would turn a convenience feature into a credential leak.
    const r = await pushCogneeProviderConfig()
    expect(r.ok).toBe(true)
    const serialised = JSON.stringify(r)
    expect(serialised).not.toContain('sk-secret-value')
    // The model and host ARE shown, so an operator can confirm the push landed.
    expect(serialised).toContain('deepseek-v4.1-flash')
    expect(serialised).toContain('proxy.example')
  })

  test('a sidecar error body is truncated, and the key is not echoed on failure either', async () => {
    state.respond = () => new Response('x'.repeat(5000), { status: 500 })
    const r = await pushCogneeProviderConfig()
    expect(r.ok).toBe(false)
    // Truncated so a wall of HTML cannot fill a toast, and short enough to stay readable in a log.
    expect((r.error ?? '').length).toBeLessThanOrEqual(200)
    expect(JSON.stringify(r)).not.toContain('sk-secret-value')
  })
})

describe('cognee provider push — fail-soft with an actionable reason', () => {
  test('no sidecar configured is reported, not thrown', async () => {
    state.serverOptions = null
    const r = await pushCogneeProviderConfig()
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/not configured|off/i)
  })

  test('no provider configured yet says WHAT to do instead of failing silently', async () => {
    // A normal state on a fresh install. The message must point at the fix, because the alternative
    // (memory stores nothing while the container reports healthy) has no other symptom.
    state.llmConfig = null
    const r = await pushCogneeProviderConfig()
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/AI Configuration/i)
  })

  test('an unreachable sidecar names the container, not a raw fetch error', async () => {
    state.respond = () => {
      throw new Error('ECONNREFUSED')
    }
    const r = await pushCogneeProviderConfig()
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/cognee container|internal network/i)
    // The raw stack must not be what an operator sees.
    expect(JSON.stringify(r)).not.toContain('ECONNREFUSED')
  })

  test('a non-200 is reported with its status', async () => {
    state.respond = () => new Response('nope', { status: 422 })
    const r = await pushCogneeProviderConfig()
    expect(r.ok).toBe(false)
    expect(r.detail).toContain('422')
  })

  test('an auth header is sent only when the sidecar has a key', async () => {
    await pushCogneeProviderConfig()
    expect(state.requests[0].headers.Authorization).toBeUndefined()
    state.serverOptions = { baseUrl: 'http://cognee:8000', apiKey: 'sidecar-token' }
    state.requests = []
    await pushCogneeProviderConfig()
    expect(state.requests[0].headers.Authorization).toBe('Bearer sidecar-token')
  })
})

describe('cognee provider push — reading back the sidecar truth', () => {
  test('returns what the sidecar reports, so intent can be compared with reality', async () => {
    // A push can be accepted and then lost to a restart. The only way to know which is to ask.
    state.respond = () =>
      new Response(JSON.stringify({ llm: { model: 'openai/x', endpoint: 'http://a/v1' } }), { status: 200 })
    const read = await readCogneeProviderConfig()
    expect(read).toEqual({ model: 'openai/x', endpoint: 'http://a/v1' })
  })

  test('an empty sidecar config reads as empty strings, not as an error', async () => {
    state.respond = () => new Response(JSON.stringify({ llm: { model: null, endpoint: null } }), { status: 200 })
    const read = await readCogneeProviderConfig()
    expect(read).toEqual({ model: '', endpoint: '' })
  })

  test('an unreachable sidecar yields null rather than a fabricated config', async () => {
    state.respond = () => {
      throw new Error('down')
    }
    expect(await readCogneeProviderConfig()).toBeNull()
  })

  test('no sidecar configured yields null', async () => {
    state.serverOptions = null
    expect(await readCogneeProviderConfig()).toBeNull()
  })
})

// Restore so a later test file in the same process is not affected by this module's stub.
process.on('exit', () => {
  globalThis.fetch = realFetch
})

describe('cognee provider push — REQUIRES an org context (the boot-time trap)', () => {
  /**
   * INCIDENT (2026-09-27), found in the production boot log:
   *
   *     [instrumentation] Memory provider not shared (Memory is off (no COGNEE_SERVER_URL).)
   *
   * on a deployment where `COGNEE_SERVER_URL=http://cognee:8000` was demonstrably set in the
   * container. The cause was the call site wrapping the push in `bypassOrg`, which runs the callback
   * with `orgStorage.run(undefined, …)` — it REMOVES the org context. Both things the push needs are
   * org-scoped: `getCogneeSettings()` returns DISABLED_SETTINGS without a context, and
   * `getLlmRuntimeConfig()` reads the org's row. So the bypass made it report "memory is off".
   *
   * The symptom is the dangerous part: the message names a MISSING ENV VAR, so the obvious response is
   * to set an env var that is already set. A guard is worth more than the fix here.
   */
  const instrumentSrc = readFileSync(join(import.meta.dir, '..', 'instrumentation.ts'), 'utf-8')

  test('the boot-time push ENTERS the org and never bypasses it', () => {
    const block = instrumentSrc.slice(instrumentSrc.indexOf('pushCogneeProviderConfig'))
    const call = block.slice(0, 1600)
    // `enterWithOrg(org.id)` must be what precedes the push.
    expect(call).toMatch(/enterWithOrg\(org\.id\)/)
    // And the push must not be inside a bypass. This is the exact shape that broke it.
    expect(call).not.toMatch(/bypassOrg\(\(\) => pushCogneeProviderConfig\(\)\)/)
  })
})
