import { beforeEach, describe, expect, mock, test } from 'bun:test'

/**
 * The memory-write worker's retry contract.
 *
 * The behaviour that matters is not "it calls the transport" — it is WHICH outcomes throw, because
 * throwing is what makes BullMQ retry and returning is what makes a lost turn permanent.
 *
 * The sidecar's refusal is the case this exists for: MEASURED, a write arriving while a dataset's
 * cognify pipeline is busy gets HTTP 200 with `{"status":"running","items_processed":0}`. That MUST
 * throw, or the retry never happens and the turn is dropped exactly as before this queue existed.
 */
const state = {
  serverOptions: { baseUrl: 'http://cognee:8000' } as { baseUrl: string } | null,
  rememberResult: null as unknown,
  calls: [] as unknown[],
}

mock.module('@/lib/cognee-core', () => ({
  getCogneeServerOptions: async () => state.serverOptions,
}))

mock.module('@/lib/cognee-http', () => ({
  cogneeRemember: async (_o: unknown, args: unknown) => {
    state.calls.push(args)
    return state.rememberResult
  },
}))

mock.module('@/lib/cognee-types', () => ({
  datasetFor: () => 'org:test',
}))

mock.module('@/lib/constants', () => ({
  MEMORY_WRITE_MAX_CHARS: 4000,
}))

mock.module('@/lib/logger', () => ({
  scopedLogger: () => ({ debug: () => {}, warn: () => {}, info: () => {}, error: () => {} }),
  log: { debug: () => {}, warn: () => {}, info: () => {}, error: () => {} },
  logSwallowed: () => {},
}))

// The worker imports `redis` only to construct a Worker; the job function is what is under test, so
// the connection is stubbed to keep this file independent of a live Redis (CI has none).
mock.module('@/lib/redis', () => ({ redis: {} }))

const { performMemoryWrite } = await import('./memory-worker')

const job = {
  organizationId: 'org-1',
  sessionId: 's1',
  userMessage: 'hi',
  aiMessage: 'hello',
  toolRuns: [{ type: 'CHAT', status: 'success', latencyMs: 5 }],
}

beforeEach(() => {
  state.serverOptions = { baseUrl: 'http://cognee:8000' }
  state.rememberResult = null
  state.calls = []
})

describe('performMemoryWrite — retryable failures MUST throw', () => {
  test('a refused concurrent write throws, so BullMQ retries it', async () => {
    // THE case this worker exists for. Not throwing here means the turn is lost with no retry.
    state.rememberResult = { status: 'running', items_processed: 0, pipeline_run_id: null }
    await expect(performMemoryWrite(job)).rejects.toThrow(/not stored/i)
  })

  test('the thrown message names what happened, so a log reader can act', async () => {
    state.rememberResult = { status: 'running', items_processed: 0 }
    try {
      await performMemoryWrite(job)
      throw new Error('should have thrown')
    } catch (e) {
      const msg = (e as Error).message
      expect(msg).toContain('running')
      expect(msg).toMatch(/retrying/i)
    }
  })

  test('a transport failure throws', async () => {
    state.rememberResult = null
    await expect(performMemoryWrite(job)).rejects.toBeInstanceOf(Error)
  })

  test('a sidecar-reported error throws', async () => {
    state.rememberResult = { error: 'dataset locked' }
    await expect(performMemoryWrite(job)).rejects.toThrow(/dataset locked/)
  })
})

describe('performMemoryWrite — success and non-retryable cases MUST NOT throw', () => {
  test('a completed write resolves', async () => {
    state.rememberResult = { status: 'completed', items_processed: 1, pipeline_run_id: 'x' }
    await expect(performMemoryWrite(job)).resolves.toBeUndefined()
  })

  test('memory disabled resolves WITHOUT throwing, so retries are not burned', async () => {
    // No sidecar configured is a deployment state, not a transient failure. Throwing would retry five
    // times against a condition that cannot change, and log five warnings for a normal install.
    state.serverOptions = null
    await expect(performMemoryWrite(job)).resolves.toBeUndefined()
    expect(state.calls).toHaveLength(0)
  })
})

describe('performMemoryWrite — the payload', () => {
  test('the turn is sent as chat_turn JSON with the org dataset', async () => {
    state.rememberResult = { status: 'completed', items_processed: 1 }
    await performMemoryWrite(job)
    const args = state.calls[0] as { texts: string[]; datasetName: string; runInBackground: boolean }
    const parsed = JSON.parse(args.texts[0]!)
    expect(parsed.type).toBe('chat_turn')
    expect(parsed.user).toBe('hi')
    expect(parsed.assistant).toBe('hello')
    expect(parsed.sessionId).toBe('s1')
    expect(args.datasetName).toBe('org:test')
    // Must be false: a backgrounded write returns before the data is searchable, so the very next
    // turn's recall would miss the fact we just "stored".
    expect(args.runInBackground).toBe(false)
  })
})
