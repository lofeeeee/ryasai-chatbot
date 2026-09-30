/**
 * GET /api/health — the DEPENDENCY-CHECKING readiness endpoint, and the one the
 * container healthcheck probes.
 *
 * WHY THIS FILE EXISTS, in one line: the bug being fixed was that the probed
 * endpoint answered `ok:true` unconditionally, so a container with a DEAD
 * POSTGRES reported healthy and was never restarted (silent-failure class #14).
 * Everything here is about proving the verdict now TRACKS a real dependency, and
 * about proving the negative control — that a dependency which is absent BY
 * DESIGN does not flip the verdict to unhealthy and start a restart loop.
 *
 * HOW THE SEAMS ARE STUBBED. The route reads `fetch` and its clients at CALL
 * time, so the seams below are plain module mocks registered BEFORE the route is
 * imported (a static import would be evaluated first and bypass them entirely,
 * concluding "the route does not leak" without ever having tested it).
 *
 * THE FILE REGISTERS ITS OWN MOCKS AND MINTS ITS OWN VERSION SEAM, deliberately:
 * `scripts/test.ts` runs each test file in its own `bun test` subprocess, so the
 * `mock.module` bleed this repo measured across files cannot reach it. It also
 * does NOT depend on another file's mock — an earlier defect in this repo was a
 * guard that asserted on a mock its SIBLING had registered, so which suite ran
 * first decided the verdict.
 */
import { describe, expect, test, beforeEach, mock } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// ---- mutable seams, declared at the TOP, ABOVE every mock.module ----
//
// Module namespace bindings are read-only in Bun, so the values the route reads
// live in `let`s in this file's scope and are exposed through the mocks' closures.
let appVersion = '0.0.0-test'

/** Count + label every seam reached, so a test can assert the complete set. */
const events: string[] = []

// --- db: mutable, so a test can make the critical check fail or pass ---
let dbMode: 'ok' | 'down' | 'hang' | 'down-with-prisma-preamble' = 'ok'
mock.module('@/lib/db', () => ({
  db: {
    document: {
      count: async () => {
        events.push('db.count')
        if (dbMode === 'hang') return new Promise<never>(() => {})
        if (dbMode === 'down') throw new Error("Can't reach database server at `db:5432`")
        if (dbMode === 'down-with-prisma-preamble') {
          // The exact multi-line shape MEASURED from a real Prisma failure once the probe is
          // wrapped in a deadline: provenance, source location, then the real diagnosis.
          throw new Error(
            'Invalid `withDeadline(db.document.count()` invocation in\n' +
              '/app/src/app/api/health/route.ts:118:36\n' +
              '\n' +
              '  115 async function probeDb(timeoutMs) {\n' +
              '  116   const start = Date.now()\n' +
              '→ 118     await withDeadline(db.document.count(\n' +
              "Can't reach database server at `db:5432`\n",
          )
        }
        return 42
      },
    },
  },
}))

// --- redis: optional ---
let redisMode: 'up' | 'down' = 'up'
mock.module('@/lib/redis', () => ({
  checkRedisHealth: async () => {
    events.push('redis.checkRedisHealth')
    return redisMode === 'up' ? { connected: true, latencyMs: 1 } : { connected: false }
  },
}))

// --- public-config: the version seam ---
mock.module('@/lib/public-config', () => ({
  publicConfig: {
    get appVersion() {
      events.push('publicConfig.appVersion')
      return appVersion
    },
    wsPort: 3003,
  },
}))

// --- license-client: the validator URL seam ---
let validatorBase: string | null = 'https://validator.test'
mock.module('@/lib/license-client', () => ({
  validatorUrl: () => {
    events.push('license.validatorUrl')
    return validatorBase
  },
}))

// --- cognee-http: the repo's own sidecar probe ---
let cogneeReady = true
let cogneeThrows = false
mock.module('@/lib/cognee-http', () => ({
  cogneeServerReady: async (opts: { baseUrl: string; timeoutMs?: number }) => {
    events.push(`cognee.ready:${opts.baseUrl}:${opts.timeoutMs}`)
    if (cogneeThrows) throw new Error('boom from a probe that must never escape')
    return cogneeReady
  },
}))

/**
 * OUTBOUND HTTP, stubbed and COUNTED. The validator, cognee and local-embeddings
 * probes all leave the process; a stub that SUCceeds without counting would let a
 * handler reach the network unnoticed, which is the property being pinned.
 *
 * The stub answers by URL so a test can drive one dependency without disturbing
 * the others, and it THROWS for anything unexpected so a probe that starts
 * dialling somewhere new fails here rather than in production.
 */
let embeddingServiceMode: 'ready' | 'loading' | 'down' | 'not-json' | 'http-500' = 'ready'
let outboundFetches = 0
const fetchedUrls: string[] = []
mock.module('@/lib/embeddings', () => ({}))
const realFetch = globalThis.fetch
globalThis.fetch = (async (input: RequestInfo | URL) => {
  const url = String(input)
  outboundFetches++
  fetchedUrls.push(url)

  // Validator: FastAPI mock answering 200 on /health.
  if (url.startsWith('https://validator.test')) {
    return new Response(JSON.stringify({ status: 'ok' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }

  // Local embedding service: mimics tools/local-embeddings/server.py.
  if (url.endsWith('/health') && url.includes('embeddings.test')) {
    if (embeddingServiceMode === 'down') throw new TypeError("Unable to connect. Is the computer able to access the url? path: \"http://embeddings.test:8081/health\"")
    if (embeddingServiceMode === 'http-500') return new Response('boom', { status: 500 })
    if (embeddingServiceMode === 'not-json') return new Response('<html>', { status: 200 })
    const loaded = embeddingServiceMode === 'ready'
    return new Response(JSON.stringify({ ok: true, model: 'some-model', loaded }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }

  throw new Error(`unexpected outbound request in test: ${url}`)
}) as unknown as typeof fetch

// DYNAMIC import — MUST come after every mock.module above.
const { GET } = await import('./route')

const ORIGINAL_ENV = {
  COGNEE_SERVER_URL: process.env.COGNEE_SERVER_URL,
  COGNEE_ENABLED: process.env.COGNEE_ENABLED,
  LOCAL_EMBEDDINGS_URL: process.env.LOCAL_EMBEDDINGS_URL,
  HEALTH_PROBE_TIMEOUT_MS: process.env.HEALTH_PROBE_TIMEOUT_MS,
  HEALTH_DB_TIMEOUT_MS: process.env.HEALTH_DB_TIMEOUT_MS,
}

function restoreEnv() {
  for (const [k, v] of Object.entries(ORIGINAL_ENV)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
}

beforeEach(() => {
  appVersion = '0.0.0-test'
  dbMode = 'ok'
  redisMode = 'up'
  validatorBase = 'https://validator.test'
  cogneeReady = true
  cogneeThrows = false
  embeddingServiceMode = 'ready'
  outboundFetches = 0
  fetchedUrls.length = 0
  events.length = 0
  restoreEnv()
  // The compose default, so every test starts from the shipped configuration:
  // both optional sidecars ADDRESSED. Tests that want the absent-by-design state
  // delete the variable explicitly.
  process.env.COGNEE_SERVER_URL = 'http://cognee.test:8000'
  process.env.LOCAL_EMBEDDINGS_URL = 'http://embeddings.test:8081'
  delete process.env.COGNEE_ENABLED
  delete process.env.HEALTH_PROBE_TIMEOUT_MS
  delete process.env.HEALTH_DB_TIMEOUT_MS
})

/** GET, then read the body ONCE as text and parse it — `res.text()` consumes the stream. */
async function call(): Promise<{
  status: number
  raw: string
  body: {
    ok: boolean
    degraded?: string[]
    service?: string
    version?: string
    time?: string
    checks: Record<string, { ok: boolean; configured: boolean; error?: string; latencyMs?: number; note?: string }>
  }
}> {
  const res = await GET()
  const raw = await res.text()
  return { status: res.status, raw, body: JSON.parse(raw) }
}

describe('/api/health — the verdict TRACKS a real dependency (the defect being fixed)', () => {
  test('a FAILING dependency is reported as not-ok, naming itself', async () => {
    // The negative control for the whole defect: cognee was previously invisible
    // behind `ok:true` (the shallow route touched nothing). Stub its probe to fail
    // and require the failure to appear in the payload.
    cogneeReady = false
    const { body } = await call()
    expect(body.checks.cognee.ok).toBe(false)
    expect(body.checks.cognee.error).toBe('Memory sidecar not ready')
    // And it is NAMED as the degraded one, rather than buried in the check map.
    expect(body.degraded).toContain('cognee')
  })

  test('a FAILING embedding service is reported as not-ok', async () => {
    embeddingServiceMode = 'down'
    const { body } = await call()
    expect(body.checks.embeddings.ok).toBe(false)
    expect(body.checks.embeddings.error).toBe('Service unreachable')
    expect(body.degraded).toContain('embeddings')
  })

  test('a dead DATABASE is 503 and not-ok — the restart signal that was missing', async () => {
    dbMode = 'down'
    const { status, body } = await call()
    expect(status).toBe(503)
    expect(body.ok).toBe(false)
    expect(body.checks.db.ok).toBe(false)
    // `db` must never appear in `degraded`: it is critical, so it fails the
    // verdict instead of being listed as a tolerable degradation.
    expect(body.degraded ?? []).not.toContain('db')
  })

  test('a HEALTHY database is 200 even when every optional dependency is down', async () => {
    // The other half of the split, in one assertion: optional failures are
    // reported but must NOT become a restart signal.
    redisMode = 'down'
    cogneeReady = false
    embeddingServiceMode = 'down'
    validatorBase = null
    const { status, body } = await call()
    expect(status).toBe(200)
    expect(body.ok).toBe(true)
    expect(body.checks.db.ok).toBe(true)
    expect((body.degraded ?? []).sort()).toEqual(['cognee', 'embeddings', 'redis', 'validator'])
  })

  test('every dependency the task names is actually probed at runtime, not just in the payload', async () => {
    const { body } = await call()
    // The KEY SET is pinned: a probe quietly removed from the handler would leave
    // this list short, which a subset check would not catch.
    expect(Object.keys(body.checks).sort()).toEqual(['cognee', 'db', 'embeddings', 'redis', 'validator'])
    // And each one left a trace in the seam log, so none of them is a constant
    // copied into the response.
    expect(events).toContain('db.count')
    expect(events).toContain('redis.checkRedisHealth')
    expect(events).toContain('license.validatorUrl')
    expect(events.some((e) => e.startsWith('cognee.ready:'))).toBe(true)
    expect(outboundFetches).toBeGreaterThanOrEqual(2) // validator + embeddings
  })
})

describe('/api/health — a MISSING optional dependency must not flip the verdict (the flap to avoid)', () => {
  test('cognee ABSENT BY DESIGN (no COGNEE_SERVER_URL) is 200, not 503', async () => {
    // Memory is optional by contract: with no server configured it is simply OFF
    // and every call is a no-op. If this were critical, every install without a
    // memory sidecar would restart-loop its app container forever.
    delete process.env.COGNEE_SERVER_URL
    const { status, body } = await call()
    expect(status).toBe(200)
    expect(body.ok).toBe(true)
    expect(body.checks.cognee.ok).toBe(false)
    // "Not configured" is NOT the same value as "down" (class 13).
    expect(body.checks.cognee.configured).toBe(false)
    expect(body.degraded).toContain('cognee')
    // And it never dialled for a service it was not told about.
    expect(fetchedUrls.some((u) => u.includes('cognee'))).toBe(false)
  })

  test('local-embeddings ABSENT BY DESIGN (no LOCAL_EMBEDDINGS_URL) is 200, not 503', async () => {
    // A BYOK install pointing at a hosted embedder runs no local service at all.
    delete process.env.LOCAL_EMBEDDINGS_URL
    const { status, body } = await call()
    expect(status).toBe(200)
    expect(body.ok).toBe(true)
    expect(body.checks.embeddings.ok).toBe(false)
    expect(body.checks.embeddings.configured).toBe(false)
    expect(body.degraded).toContain('embeddings')
    expect(fetchedUrls.some((u) => u.includes('embeddings.test'))).toBe(false)
  })

  test('BOTH optional sidecars absent is still 200 — the shipped-minimum install', async () => {
    delete process.env.COGNEE_SERVER_URL
    delete process.env.LOCAL_EMBEDDINGS_URL
    const { status, body } = await call()
    expect(status).toBe(200)
    expect(body.ok).toBe(true)
  })

  test('COGNEE_ENABLED=false is a deliberate OFF, not an outage, and is not dialled', async () => {
    process.env.COGNEE_ENABLED = 'false'
    delete process.env.COGNEE_SERVER_URL
    const { status, body } = await call()
    expect(status).toBe(200)
    expect(body.ok).toBe(true)
    expect(body.checks.cognee.configured).toBe(false)
  })

  test('a WARMING embedder (ok:true, loaded:false) is healthy, not a failure', async () => {
    // The service answers during weight download by design, and its own compose
    // healthcheck accepts that. Rejecting it here would flap a healthy container
    // for the ~470MB a first boot downloads.
    embeddingServiceMode = 'loading'
    const { status, body } = await call()
    expect(status).toBe(200)
    expect(body.checks.embeddings.ok).toBe(true)
  })

  test('a validator that was never configured does not fail the verdict', async () => {
    validatorBase = null
    const { status, body } = await call()
    expect(status).toBe(200)
    expect(body.checks.validator.ok).toBe(false)
    expect(body.checks.validator.configured).toBe(false)
  })
})

describe('/api/health — no probe may hang or throw out of the handler', () => {
  test('a hung database probe becomes a 503 within the deadline, not a hang', async () => {
    // The healthcheck reads this HTTP status. A probe that never settles cannot be
    // told apart from a wedged process, and the restart decision never arrives.
    process.env.HEALTH_DB_TIMEOUT_MS = '150'
    dbMode = 'hang'
    const started = Date.now()
    const { status, body } = await call()
    const elapsed = Date.now() - started
    expect(status).toBe(503)
    expect(body.checks.db.ok).toBe(false)
    expect(body.checks.db.error).toContain('Database probe exceeded 150ms')
    expect(elapsed).toBeLessThan(2000)
  })

  test('a cognee probe that THROWS is caught, reported, and still 200', async () => {
    cogneeThrows = true
    const { status, body } = await call()
    expect(status).toBe(200)
    expect(body.checks.cognee.ok).toBe(false)
    expect(body.checks.cognee.error).toBe('Memory sidecar not ready')
  })

  test('the configured probe timeout reaches the sidecar probe', async () => {
    process.env.HEALTH_PROBE_TIMEOUT_MS = '900'
    await call()
    expect(events.some((e) => e.startsWith('cognee.ready:http://cognee.test:8000:900'))).toBe(true)
  })

  test('a non-JSON and an HTTP-500 answer are both failures, never a throw', async () => {
    embeddingServiceMode = 'not-json'
    const a = await call()
    expect(a.status).toBe(200)
    expect(a.body.checks.embeddings.error).toBe('Service answered with a non-JSON body')

    embeddingServiceMode = 'http-500'
    const b = await call()
    expect(b.status).toBe(200)
    expect(b.body.checks.embeddings.error).toBe('Service returned HTTP 500')
  })
})

describe('/api/health — the deep endpoint is on a restart path, so it must not leak', () => {
  test('no internal host, port or connection string reaches the anonymous caller', async () => {
    // This endpoint is unauthenticated (middleware allow-list) AND its body is
    // printed into the container log by the compose healthcheck. A leaked
    // endpoint therefore reaches both the log and any anonymous scraper.
    dbMode = 'down'
    cogneeReady = false
    embeddingServiceMode = 'down'
    const { raw } = await call()
    const lower = raw.toLowerCase()
    for (const needle of [
      'cognee.test',
      'embeddings.test',
      'validator.test',
      'postgresql://',
      'postgres://',
      'rediss://',
      'redis://',
      'db:5432',
      'password',
      'apikey',
      'api_key',
      'authorization',
      'bearer',
      'secret',
      'encryption',
      'localhost',
      '127.0.0.1',
      '/home/',
    ]) {
      expect(lower).not.toContain(needle)
    }
  })

  test('a raw driver error is reduced to its CLASS, with the endpoint redacted', async () => {
    // MEASURED gap: the old rule only stripped parenthesised text, so Prisma's
    // "Can't reach database server at `db:5432`" — no parentheses anywhere — went
    // out verbatim with the host and port.
    dbMode = 'down'
    const { body } = await call()
    expect(body.checks.db.error).toBe("Can't reach database server at <redacted>")
    expect(body.checks.db.error).not.toContain('db:5432')
  })

  test('the reported CLASS is the DIAGNOSIS, not the deadline helper that wrapped it', async () => {
    /*
     * Found by running the real handler against a genuinely dead Postgres, not by reading the
     * code: wrapping the DB probe in a deadline makes Prisma prefix a three-layer preamble, so
     * "take the first line" reported `Invalid \`withDeadline` — naming OUR helper while the
     * line that identifies the fault sat underneath it. That preamble also embeds a SOURCE PATH
     * and a code snippet, which this endpoint must not publish.
     *
     * The stub reproduces the exact shape measured on the wire.
     */
    dbMode = 'down-with-prisma-preamble'
    const { body } = await call()
    expect(body.checks.db.error).toBe("Can't reach database server at <redacted>")
    expect(body.checks.db.error).not.toContain('withDeadline')
    expect(body.checks.db.error).not.toContain('.ts:')
  })
})

describe('/api/health — the container healthcheck probes THIS endpoint, in BOTH composes', () => {
  /**
   * THE WIRING IS THE FIX. Making this endpoint honest changes nothing if the
   * container keeps probing the endpoint that touches nothing — the deployment
   * would still report healthy with Postgres dead, which is the defect verbatim.
   * Both the tracked compose and the one install.sh GENERATES are read, because
   * production runs the generated one and a fix in only one of them ships a
   * deployment that still lies.
   */
  const root = join(import.meta.dir, '..', '..', '..', '..')
  const readRepo = (rel: string) => readFileSync(join(root, rel), 'utf-8')

  /** The `app:` service block, comments stripped, so prose cannot satisfy an assertion. */
  function appBlock(src: string): string {
    const start = src.search(/^\s{2}app:\s*$/m)
    expect(start).toBeGreaterThan(-1)
    const rest = src.slice(start)
    const end = rest.slice(1).search(/^\s{2}[a-z][a-z0-9_-]*:\s*$/m)
    const block = end === -1 ? rest : rest.slice(0, end + 1)
    return block
      .split('\n')
      .map((l) => (l.trimStart().startsWith('#') ? '' : l))
      .join('\n')
  }

  for (const file of ['docker-compose.yml', 'install.sh']) {
    test(`${file}: the app healthcheck probes /api/health, the dependency-checking route`, () => {
      const block = appBlock(readRepo(file))
      const test = block.match(/test:\s*\[[^\]]*\]/)?.[0] ?? ''
      expect(test).toContain('/api/health')
      // NEGATIVE: NOT the shallow route. Matching only the first means
      // `/api/v1/health` — which CONTAINS `/api/health`? No: it contains
      // `/api/v1/health`, so assert the shallow path is absent outright.
      expect(test).not.toContain('/api/v1/health')
    })

    test(`${file}: the app healthcheck tolerates a reboot without flapping`, () => {
      const block = appBlock(readRepo(file))
      const interval = Number(block.match(/interval:\s*(\d+)s/)?.[1] ?? 0)
      const retries = Number(block.match(/retries:\s*(\d+)/)?.[1] ?? 0)
      const startPeriod = Number(block.match(/start_period:\s*(\d+)s/)?.[1] ?? 0)
      // One failed probe must not mark the container unhealthy: the budget from
      // `retries` x `interval` spans minutes, and `start_period` covers a cold
      // boot (migrate + schema push) without a spurious restart.
      expect(retries).toBeGreaterThanOrEqual(3)
      expect(interval * retries).toBeGreaterThanOrEqual(120)
      expect(startPeriod).toBeGreaterThanOrEqual(120)
    })

    test(`${file}: the healthcheck timeout EXCEEDS the deep endpoint's own probe budget`, () => {
      // Otherwise the check is aborted before the endpoint can answer, and a
      // SLOW report reads as a FAILED container. The endpoint's worst case is its
      // longest single probe (the validator, 2500ms default), not the sum.
      const block = appBlock(readRepo(file))
      const timeout = Number(block.match(/timeout:\s*(\d+)s/)?.[1] ?? 0)
      expect(timeout * 1000).toBeGreaterThan(2500)
    })
  }
})
