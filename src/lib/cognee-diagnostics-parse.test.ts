/**
 * Parse a REAL /health/detailed payload captured from the production sidecar.
 *
 * The fixture is the verbatim response, not a hand-written sample: the point is to prove the parser
 * handles the shape the server actually sends, including the 30s embedding timeout value and the
 * multi-line llm error text.
 */
import { describe, expect, test } from 'bun:test'
import { cogneeServerDiagnostics } from './cognee-http'

const REAL = `{"status":"degraded","timestamp":"2026-09-27T07:22:21.552088+00:00","version":"1.6.0-local","uptime":254,"components":{"relational_db":{"status":"healthy","provider":"sqlite","response_time_ms":22,"details":"Connection successful"},"vector_db":{"status":"healthy","provider":"lancedb","response_time_ms":0,"details":"Index accessible"},"graph_db":{"status":"healthy","provider":"kuzu","response_time_ms":7,"details":"Schema validated"},"file_storage":{"status":"healthy","provider":"local","response_time_ms":2,"details":"Storage accessible"},"llm_provider":{"status":"degraded","provider":"unknown","response_time_ms":17,"details":"API check failed: LLMAPIKeyNotSetError: LLM API key is not set. (Status code: 422) Fix: Set LLM_API_KEY in your .env"},"embedding_service":{"status":"degraded","provider":"unknown","response_time_ms":30002,"details":"Embedding test failed: Embedding connection test timed out after 30s."}}}`

describe('cogneeServerDiagnostics parses the real payload', () => {
  test('every component is extracted with its status and provider', async () => {
    const orig = globalThis.fetch
    globalThis.fetch = (async () =>
      new Response(REAL, { status: 200 })) as unknown as typeof fetch
    try {
      const d = await cogneeServerDiagnostics({ baseUrl: 'http://x' })
      expect(d).not.toBeNull()
      expect(d!.status).toBe('degraded')
      expect(d!.version).toBe('1.6.0-local')
      expect(d!.uptimeSeconds).toBe(254)
      expect(d!.components).toHaveLength(6)
      const names = d!.components.map((c) => c.name)
      expect(names).toContain('llm_provider')
      expect(names).toContain('embedding_service')
      const llm = d!.components.find((c) => c.name === 'llm_provider')!
      expect(llm.status).toBe('degraded')
      expect(llm.details).toContain('LLMAPIKeyNotSetError')
      // The 30s value matters: it is the tell for the known-flaky embedding probe, and a parser
      // that dropped response_time_ms would hide the difference between a real failure and a timeout.
      const emb = d!.components.find((c) => c.name === 'embedding_service')!
      expect(emb.responseTimeMs).toBe(30002)
    } finally {
      globalThis.fetch = orig
    }
  })

  test('an unknown status string becomes "unknown", never a fabricated healthy', async () => {
    const orig = globalThis.fetch
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ status: 'x', components: { weird: { status: 'banana' } } }), {
        status: 200,
      })) as unknown as typeof fetch
    try {
      const d = await cogneeServerDiagnostics({ baseUrl: 'http://x' })
      expect(d!.components[0].status).toBe('unknown')
    } finally {
      globalThis.fetch = orig
    }
  })

  test('an unreachable sidecar yields null, not an empty diagnosis', async () => {
    const orig = globalThis.fetch
    globalThis.fetch = (async () => {
      throw new Error('ECONNREFUSED')
    }) as unknown as typeof fetch
    try {
      expect(await cogneeServerDiagnostics({ baseUrl: 'http://x' })).toBeNull()
    } finally {
      globalThis.fetch = orig
    }
  })

  test('a 503 WITH a body is parsed — that is what the real server returns', async () => {
    // MEASURED on production: /health/detailed answers HTTP 503 and a complete JSON body. Treating
    // a non-2xx as "unreachable" returned null in exactly the situation this endpoint exists for.
    // The negative control that caught this: the earlier `res.ok` version returned null here.
    const orig = globalThis.fetch
    globalThis.fetch = (async () =>
      new Response(REAL, { status: 503 })) as unknown as typeof fetch
    try {
      const d = await cogneeServerDiagnostics({ baseUrl: 'http://x' })
      expect(d, 'a diagnostic body must not be discarded because of its status code').not.toBeNull()
      expect(d!.components).toHaveLength(6)
      expect(d!.components.find((c) => c.name === 'llm_provider')!.status).toBe('degraded')
    } finally {
      globalThis.fetch = orig
    }
  })

  test('a 500 with an HTML body still yields null, not a partial diagnosis', async () => {
    const orig = globalThis.fetch
    globalThis.fetch = (async () =>
      new Response('<html>proxy error</html>', { status: 500 })) as unknown as typeof fetch
    try {
      expect(await cogneeServerDiagnostics({ baseUrl: 'http://x' })).toBeNull()
    } finally {
      globalThis.fetch = orig
    }
  })
})
