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
  /**
   * What the sidecar's OWN health probe reports about its LLM provider.
   *
   * This is the signal that replaced the old `!stored.endpoint` test, which was true on EVERY push
   * because `save_llm_config` never stores an endpoint — so it told operators to add a line that was
   * already in `.env.cognee`. `'healthy'` here is the production shape.
   */
  llmProviderStatus: 'healthy' as string,
  llmProviderDetails: 'API responding' as string,
  llmConfig: null as { id: string; provider: string; baseUrl: string; apiKey: string; model: string } | null,
  /**
   * Which row the memory credentials came from. In production `getMemoryLlmConfig()` prefers a
   * `purpose: 'memory'` row and falls back to chat; the push mechanics are identical either way, so
   * this is the only extra input the tests need. A second mocked function with its own fixture would
   * let the two disagree about WHICH model is being pushed — the one thing these tests exist to pin.
   */
  memorySource: 'chat' as 'memory' | 'chat',
  requests: [] as Array<{ url: string; body: unknown; headers: Record<string, string> }>,
  respond: (() => new Response('{}', { status: 200 })) as () => Response,
}

mock.module('@/lib/cognee-core', () => ({
  getCogneeServerOptions: async () => state.serverOptions,
}))

mock.module('@/lib/llm-config', () => ({
  getLlmRuntimeConfig: async () => state.llmConfig,
  // The push reads the MEMORY credentials. This must exist here because the module is consumed
  // through a partial mock: a missing export is a SyntaxError at import, not a failed assertion.
  getMemoryLlmConfig: async () =>
    state.llmConfig ? { ...state.llmConfig, source: state.memorySource } : null,
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
  // /health/detailed carries the LLM-provider verdict; everything else goes to the per-test stub.
  if (String(url).endsWith('/health/detailed')) {
    return new Response(
      JSON.stringify({
        status: state.llmProviderStatus === 'healthy' ? 'healthy' : 'degraded',
        components: {
          llm_provider: { status: state.llmProviderStatus, provider: 'openai', details: state.llmProviderDetails },
        },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
  }
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
  state.llmProviderStatus = 'healthy'
  state.llmProviderDetails = 'API responding'
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

describe('cognee provider push — the endpoint is DROPPED by the sidecar, and we say so', () => {
  /**
   * MEASURED against cognee 1.6.0's `save_llm_config`, read on the production host:
   *
   *     llm_config.llm_provider = new_llm_config.provider
   *     llm_config.llm_model    = new_llm_config.model
   *     if "*****" not in ...: llm_config.llm_api_key = ...
   *
   * There is NO endpoint assignment. Posting `endpoint: "http://example.test/v1"` stored `''` —
   * verified — and the same for `api_base`, `baseUrl` and `apiEndpoint`. An OpenAI-compatible gateway
   * therefore cannot be configured through this API in any spelling.
   *
   * THE DANGEROUS OUTCOME IS A FALSE SUCCESS. The push does genuinely share provider/model/key, so
   * returning `ok: true` is correct; but without reporting the dropped endpoint the operator would see
   * "shared" while the sidecar called api.openai.com and failed with an authentication error naming
   * the wrong provider. So success is reported WITH the remaining gap.
   */
  test('AN EMPTY endpoint IN THE READ-BACK IS NOT A FAULT (the reported false alarm)', async () => {
    /*
     * USER-REPORTED DEFECT, and the one this test now pins.
     *
     * The sidecar's settings API never stores an endpoint, so `endpoint` comes back as `''` on every
     * install no matter how correctly it is configured. The old condition was `!stored.endpoint`, so
     * the warning fired on EVERY push and told operators to add a line that was already in
     * `.env.cognee`:
     *
     *     "Add OPENAI_API_BASE=https://proxy.ryasai.my.id/v1 to .env.cognee and restart the sidecar"
     *
     * MEASURED on the install it fired on: that exact line was present, and the sidecar's own
     * `llm_provider` component read `healthy / API responding`. Nothing was wrong. A warning that is
     * always on carries no information and teaches an operator to ignore the case that matters.
     *
     * So an empty endpoint with a HEALTHY provider must be a clean success. The empty string is
     * treated as "the API does not carry this field", which is what it is.
     */
    // The read-back MUST echo the model the push sent. Answering a different one sets `modelMismatch`,
    // whose `error` is a separate, legitimate arm — and this test asserts `error` is undefined, so a
    // mismatched fixture would fail it for the wrong reason. (The first draft used `openai/x` and did
    // exactly that: the endpoint arm was correctly silent, and the failure came from the model arm.)
    state.respond = () =>
      new Response(JSON.stringify({ llm: { model: 'openai/cbcn/deepseek-v4.1-flash', endpoint: '' } }), {
        status: 200,
      })
    const r = await pushCogneeProviderConfig()
    expect(r.ok).toBe(true)
    // The alarm must NOT fire: the provider is healthy, so there is nothing to fix.
    expect(r.endpointNeedsEnv).toBeUndefined()
    expect(r.error).toBeUndefined()
  })

  test('an UNUSABLE provider still gets the endpoint remedy, with the measured status', async () => {
    // The actionable replacement. The sidecar's own probe says the provider cannot be used, so the
    // operator is told the measured verdict AND the line that is the likely fix. This is the case the
    // old always-on warning was drowning out.
    state.llmProviderStatus = 'degraded'
    state.llmProviderDetails = 'LLMAPIKeyNotSetError: LLM API key is not set'
    state.respond = () => new Response(JSON.stringify({ llm: { model: 'openai/x', endpoint: '' } }), { status: 200 })
    const r = await pushCogneeProviderConfig()
    expect(r.ok).toBe(true) // the credentials DID land; the provider problem is separate
    expect(r.endpointNeedsEnv).toBe(true)
    expect(r.endpointValue).toBe('https://proxy.example/v1')
    expect(r.error).toContain('degraded')
    expect(r.error).toContain('OPENAI_API_BASE=https://proxy.example/v1')
    expect(r.error).toContain('.env.cognee')
    // The key must not ride along with the message.
    expect(JSON.stringify(r)).not.toContain('sk-secret-value')
  })

  test('a sidecar that reports everything correctly gets a clean success', async () => {
    // Guards against the flag being hardcoded true: a future cognee that supports endpoints must not
    // keep telling operators to edit a file they no longer need to touch.
    //
    // The read-back echoes the PUSHED model. It used to answer `openai/x`, which is a DIFFERENT model
    // from the one sent (`openai/cbcn/deepseek-v4.1-flash`) — the old code never looked at `stored.model`,
    // so the fixture could be unrealistic and the test still passed. Now that a model mismatch is
    // reported, this fixture must represent what the test claims to exercise: a sidecar that stored
    // everything correctly. The mismatch case has its own tests below.
    state.respond = () =>
      new Response(
        JSON.stringify({
          llm: { model: 'openai/cbcn/deepseek-v4.1-flash', endpoint: 'https://proxy.example/v1' },
        }),
        { status: 200 },
      )
    const r = await pushCogneeProviderConfig()
    expect(r.ok).toBe(true)
    expect(r.endpointNeedsEnv).toBeUndefined()
    expect(r.error).toBeUndefined()
    expect(r.modelMismatch).toBeUndefined()
  })

  test('an unreadable read-back does not fabricate a warning', async () => {
    // readCogneeProviderConfig returns null when the sidecar cannot be read. Treating null as "endpoint
    // missing" would warn on every push against a sidecar that merely did not answer the GET.
    let calls = 0
    state.respond = () => {
      calls += 1
      if (calls === 1) return new Response('{}', { status: 200 })
      throw new Error('unreadable')
    }
    const r = await pushCogneeProviderConfig()
    expect(r.ok).toBe(true)
    expect(r.endpointNeedsEnv).toBeUndefined()
    // Same rule for the model: an unreadable sidecar must not be reported as holding the wrong model.
    expect(r.modelMismatch).toBeUndefined()
    expect(r.error).toBeUndefined()
  })
})

describe('cognee provider push — the MODEL read-back was fetched and discarded', () => {
  /**
   * MEASURED before the fix, with a stubbed settings endpoint: a sidecar answering `{"llm":{"model":""}}`
   * (it stored nothing) and one answering a DIFFERENT model both produced
   * `ok: true, detail: "Shared openai/<the model we sent> at <endpoint>"`.
   *
   * `readCogneeProviderConfig()` was already being called — for its `endpoint` alone. `stored.model` was
   * read and thrown away, so the reported detail and the audit row described the INTENT rather than what
   * the sidecar kept. That is the module's own documented failure mode: a sidecar that silently extracts
   * with the wrong model, while every surface says the push landed.
   *
   * `ok` stays true because provider and key were genuinely accepted; what is reported is the gap.
   */
  test('a sidecar holding a DIFFERENT model is reported, not claimed as shared', async () => {
    state.respond = () =>
      new Response(
        JSON.stringify({ llm: { model: 'openai/gpt-4o', endpoint: 'https://proxy.example/v1' } }),
        { status: 200 },
      )
    const r = await pushCogneeProviderConfig()
    expect(r.ok).toBe(true)
    expect(r.modelMismatch).toBe(true)
    // The detail must name what the SIDECAR holds, so an operator reads reality not intent.
    expect(r.detail).toContain('openai/gpt-4o')
    expect(r.error).toContain('openai/gpt-4o')
    // The remedy is stated, and the key still must not ride along.
    expect(r.error).toMatch(/Push again/)
    expect(JSON.stringify(r)).not.toContain('sk-secret-value')
  })

  test('a sidecar holding NO model is reported as such, not as a successful share', async () => {
    // The restart case named in this module's docstring: cognee's settings are in-memory, so a restart
    // empties them. `''` is what the endpoint returns then — and `!stored.model` must be treated as a
    // mismatch, since an empty model is not the model we sent.
    state.respond = () =>
      new Response(JSON.stringify({ llm: { model: '', endpoint: 'https://proxy.example/v1' } }), {
        status: 200,
      })
    const r = await pushCogneeProviderConfig()
    expect(r.ok).toBe(true)
    expect(r.modelMismatch).toBe(true)
    expect(r.detail).toContain('(no model)')
    expect(r.error).toContain('"')
  })

  test('an exactly-matching model is NOT flagged (the control)', async () => {
    // Without this direction, `modelMismatch: true` unconditional would satisfy both tests above.
    state.respond = () =>
      new Response(
        JSON.stringify({
          llm: { model: 'openai/cbcn/deepseek-v4.1-flash', endpoint: 'https://proxy.example/v1' },
        }),
        { status: 200 },
      )
    const r = await pushCogneeProviderConfig()
    expect(r.modelMismatch).toBeUndefined()
    expect(r.detail).not.toContain('but the sidecar reports')
  })

  test('the endpoint gap and the model gap are reported TOGETHER, not mutually exclusive', async () => {
    // Both are properties of the same read-back. An `else if` between them would hide one whenever the
    // other fired — and on cognee 1.6.0 the endpoint is ALWAYS dropped, so that shape would mean the
    // model mismatch could never be reported in production at all.
    state.llmProviderStatus = 'degraded'
    state.respond = () => new Response(JSON.stringify({ llm: { model: 'openai/gpt-4o', endpoint: '' } }), { status: 200 })
    const r = await pushCogneeProviderConfig()
    expect(r.endpointNeedsEnv).toBe(true)
    expect(r.modelMismatch).toBe(true)
  })
})

/**
 * The push reads the MEMORY credentials, not the chat row directly.
 *
 * WHY THIS IS A SEPARATE CONCERN FROM THE MECHANICS ABOVE. The push used to call
 * `getLlmRuntimeConfig()` — the chat row, always. Now it calls `getMemoryLlmConfig()`, which prefers
 * a `purpose: 'memory'` row and falls back to chat. Every assertion above still passes if that call
 * is reverted, because the fallback makes chat the answer in most fixtures — so without these tests
 * the feature could be dead and the suite would stay green. That is silent-failure class 5: the
 * mechanism correct and tested while the call site bypasses it.
 */
describe('cognee provider push — the credentials come from the MEMORY config', () => {
  test('a dedicated memory source reports itself as such in the result', async () => {
    // The operator-facing half: the UI can only say "memory is on its own model" if this survives the
    // round trip. Dropping it would make the feature invisible exactly when it is in use.
    state.memorySource = 'memory'
    const result = await pushCogneeProviderConfig()
    expect(result.ok).toBe(true)
    expect(result.source).toBe('memory')
  })

  test('following chat is reported as `chat`, distinctly from a dedicated model', async () => {
    state.memorySource = 'chat'
    const result = await pushCogneeProviderConfig()
    expect(result.source).toBe('chat')
  })

  test('the model PUSHED is the memory model, not the chat model', async () => {
    /*
     * The behavioural half, and the assertion that actually fails if the call site is reverted. The
     * fixture deliberately gives the mocked memory resolver a DIFFERENT model than the chat row would
     * produce, so "which function was called" is observable in the request body rather than only in a
     * mock's call count.
     */
    state.memorySource = 'memory'
    state.llmConfig!.model = 'memory-only-model'
    await pushCogneeProviderConfig()
    const body = state.requests[0].body as { llm: { model: string } }
    expect(body.llm.model).toBe('openai/memory-only-model')
  })
})
