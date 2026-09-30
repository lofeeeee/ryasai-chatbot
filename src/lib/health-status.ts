/**
 * Health-check status helpers — pure logic extracted from /api/health so the
 * aggregation rules are unit-testable without a DB/Redis/HTTP round-trip.
 */

export type CheckStatus = {
  ok: boolean
  latencyMs?: number
  error?: string
}

/**
 * THE critical/reported SPLIT, in one place.
 *
 * CRITICAL — decides the HTTP status, and therefore the container's exit code
 * through the compose healthcheck:
 *
 *   db   Prisma/Postgres. Nothing in this product works without it: auth,
 *        documents, chat history, audit and every tenant query are DB reads.
 *        A 503 here is the truth, and it is the signal that was MISSING:
 *        the container healthcheck used to probe the shallow /api/v1/health
 *        and decide on `r.ok`, so **with Postgres dead the container still
 *        reported healthy** and no orchestrator ever restarted it (silent
 *        failure class #14 — a dead mechanism reporting itself healthy).
 *
 * REPORTED-BUT-NOT-CRITICAL — named in the response and listed under `degraded`,
 * never in the status code:
 *
 *   redis       optional by design. The app degrades to synchronous processing
 *               and in-memory rate limits (documented in lib/redis.ts).
 *   validator   our central License-Validator. It retries on its own schedule
 *               with a grace period, so a momentary blip must not page anyone
 *               or restart the app.
 *   cognee      the memory sidecar. Memory is OPTIONAL by contract: with
 *               `COGNEE_SERVER_URL` unset it is simply OFF, and every call
 *               degrades to a no-op. The compose app service deliberately waits
 *               only `service_started` for it so a warming graph cannot become
 *               a total outage — making it critical here would undo that.
 *   embeddings  the bundled local embedding service. Optional for the same
 *               reason: a deployment using a hosted embedder (BYOK) does not run
 *               it at all, so a critical probe would fail forever on a healthy
 *               install and restart-loop it.
 *
 * WHY THE SPLIT IS LOAD-BEARING: a container healthcheck that fails on a
 * transient sidecar blip causes a restart loop over a dependency the product is
 * designed to survive. Only a dependency whose loss means "this process cannot
 * serve its purpose" belongs on the restart path.
 */
export const CRITICAL_CHECKS: ReadonlySet<string> = new Set(['db'])

/** Is this check allowed to fail the response (503) and the container healthcheck? */
export function isCriticalCheck(name: string): boolean {
  return CRITICAL_CHECKS.has(name)
}

/**
 * Aggregate individual dependency checks into a response verdict.
 *
 * ponytail: ONLY `db` is critical — see CRITICAL_CHECKS above for the reasoning
 * behind each entry. Everything else is reported and degraded, never fatal.
 */
export function aggregateHealth(checks: Record<string, CheckStatus>): {
  ok: boolean
  degraded: string[]
} {
  const degraded: string[] = []
  let ok = true
  for (const [name, check] of Object.entries(checks)) {
    if (check.ok) continue
    if (isCriticalCheck(name)) ok = false
    else degraded.push(name)
  }
  return { ok, degraded }
}

/**
 * The per-probe deadlines, in milliseconds.
 *
 * WHY THE DEEP ENDPOINT NEEDS THEM AT ALL: it is on the container healthcheck
 * path, so an unbounded probe is worse than a failing one — a probe that never
 * settles cannot be distinguished from a hung process, and while it hangs the
 * HTTP status that decides the restart never arrives.
 *
 * WHY THEY ARE OPERATOR-TUNABLE AND CLAMPED: the values are a POLICY (how long a
 * dependency may take before this deployment calls it unhealthy), not a
 * measurement, so a slow box must be able to raise them without a code change.
 * The clamp keeps the endpoint from being turned into a hang by a typo
 * (`HEALTH_PROBE_TIMEOUT_MS=99999999`).
 *
 * Read at CALL time, not at module load: a test (or an operator changing the
 * value on a running box) would otherwise keep the value captured at import.
 */
const TIMEOUT_FLOOR_MS = 50
const TIMEOUT_CEIL_MS = 30_000

export function defaultProbeTimeouts(): { dbMs: number; probeMs: number; validatorMs: number } {
  return {
    // Measured on the live deployment: the DB round trip is ~45ms. 2500ms is
    // ~55x that, so it absorbs a cold pool without masking a dead database.
    dbMs: readTimeout('HEALTH_DB_TIMEOUT_MS', 2500),
    // Optional sidecars. Short on purpose: they are reported, and a slow answer
    // from one of them must not hold up the status that decides a restart.
    probeMs: readTimeout('HEALTH_PROBE_TIMEOUT_MS', 1500),
    // Shared by BOTH validator paths (/health then /), so the total the deep
    // endpoint can spend on the validator is this, not twice this.
    validatorMs: readTimeout('HEALTH_VALIDATOR_TIMEOUT_MS', 2500),
  }
}

function readTimeout(name: string, fallback: number): number {
  const raw = Number(process.env[name])
  if (!Number.isFinite(raw) || raw <= 0) return fallback
  return Math.min(Math.max(Math.round(raw), TIMEOUT_FLOOR_MS), TIMEOUT_CEIL_MS)
}

/**
 * Bound a promise by a deadline.
 *
 * Rejects with a LABELLED timeout error so the probe can report "db exceeded
 * 2500ms" instead of hanging. The label is a static string, never a URL or a
 * driver message — this error reaches an anonymous caller through
 * `sanitizeHealthError`.
 */
export function withDeadline<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} exceeded ${ms}ms`)), ms)
  })
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer)) as Promise<T>
}

/**
 * Probe an internal service's own `/health`-style endpoint.
 *
 * WHY THIS EXISTS INSTEAD OF THE APP'S EMBEDDING CLIENT: `getEmbeddingRuntimeConfig()`
 * deliberately refuses to resolve without an org context — proven necessary,
 * because a context-free `findFirst()` returned ANOTHER tenant's model AND base
 * URL (trial/55). This route has no session and therefore no org, so it cannot
 * use that client without weakening that guard, which is not negotiable. It
 * probes the SERVICE instead, at the deployment-level URL the compose file
 * states, on the same path the service's own compose healthcheck uses.
 *
 * NEVER THROWS — every failure is a returned status. And the failure strings are
 * STATIC, not `e.message`: a Bun fetch error carries `path: "http://host:port/..."`
 * in its message, so echoing it here would publish internal service names and
 * ports to anonymous callers of an unauthenticated endpoint.
 */
export async function probeServiceHealth(args: {
  url: string
  timeoutMs: number
  /** Injectable for tests; defaults to the global fetch at call time. */
  fetchImpl?: typeof fetch
}): Promise<CheckStatus> {
  const doFetch = args.fetchImpl ?? fetch
  const start = Date.now()
  try {
    const res = await doFetch(args.url, {
      method: 'GET',
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(args.timeoutMs),
    })
    const latencyMs = Date.now() - start
    if (!res.ok) {
      // The STATUS code is safe to report; the URL is not, so it never appears.
      return { ok: false, latencyMs, error: `Service returned HTTP ${res.status}` }
    }
    try {
      const body = (await res.json()) as { ok?: unknown } | null
      if (body && body.ok === true) return { ok: true, latencyMs }
      return { ok: false, latencyMs, error: 'Service answered without ok:true' }
    } catch {
      return { ok: false, latencyMs, error: 'Service answered with a non-JSON body' }
    }
  } catch {
    return { ok: false, latencyMs: Date.now() - start, error: 'Service unreachable' }
  }
}

/**
 * Keep only the leading error CLASS from a raw error, capped at 120 chars.
 * "Connection terminated due to connection timeout (…db.internal.prod:5432…)"
 * becomes "Connection terminated…" — enough to debug, nothing to recon with.
 * This endpoint's output reaches anonymous callers (middleware allow-list), so
 * raw driver errors (hosts, SQL, file paths) must never pass through.
 *
 * MEASURED GAP in the parenthesised-only rule this started as: a real Prisma
 * connection failure reads
 *
 *   Can't reach database server at `db:5432`
 *
 * — no parentheses anywhere — so the host and port went out verbatim. The deep
 * endpoint is on the container healthcheck path now, which prints the failing
 * body into the container log, so the redaction was widened to the shapes a
 * leaked endpoint takes: URLs, backticked tokens, dotted hostnames and IPs (with
 * or without a port).
 *
 * SECOND MEASURED GAP, found by running the real handler against a genuinely dead
 * Postgres rather than by reading this function. Wrapping the DB probe in a
 * deadline changes the error Prisma throws — it prefixes its own preamble:
 *
 *   Invalid `withDeadline(db.document.count()` invocation in
 *   /app/src/app/api/health/route.ts:118:36
 *   Can't reach database server at `127.0.0.1:1`
 *
 * so "take the first line" reported `Invalid \`withDeadline` — an error CLASS
 * naming our own helper and saying nothing about the fault, while the line that
 * identifies the problem ("Can't reach database server") sat underneath it. The
 * preamble is therefore SKIPPED: a provenance line is not a diagnosis, and an
 * operator reading this at 3am needs the diagnosis. Skipping it also matters for
 * privacy, because that preamble embeds a SOURCE PATH.
 */
export function sanitizeHealthError(e: unknown, fallback: string): string {
  if (!(e instanceof Error)) return fallback
  const meaningful = e.message
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    // Prisma's provenance preamble, which wraps the REAL message in three layers:
    //   1. `Invalid \`<our expression>\` invocation in`
    //   2. the source location, as `route.ts:118:36` or `/app/src/…:118:36`
    //   3. a quoted code snippet — line-number-prefixed (`118 await …`) or
    //      arrow-prefixed (`→ 118 …`)
    // Every one of these names the WRAPPER, not the fault, and layer 2/3 also
    // leak a source path. The first line surviving all five filters is the
    // diagnosis ("Can't reach database server at …").
    .filter((line) => !/^Invalid `.*`\s+invocation\b/.test(line))
    .filter((line) => !/^→/.test(line))
    .filter((line) => !/^\d+\s/.test(line))
    .filter((line) => !/^\S*\.\w+:\d+:\d+$/.test(line))
    .filter((line) => !/^(?:[A-Za-z]:)?[/\\].*:\d+:\d+$/.test(line))

  const first = (meaningful[0] ?? e.name).split('(')[0].trim() || e.name
  return redactEndpoints(first).slice(0, 120)
}

const ENDPOINT_SHAPES = [
  /`[^`]*`/g, // driver-quoted identifiers: `db:5432`
  /[a-z][a-z0-9+.-]*:\/\/[^\s)]+/gi, // URLs: postgresql://…, http://…
  /\b(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?\b/g, // IPv4, optionally with a port
  /\b(?:[a-z0-9-]+\.)+[a-z]{2,}(?::\d+)?\b/gi, // dotted hostnames, optionally with a port
]

function redactEndpoints(text: string): string {
  let out = text
  for (const shape of ENDPOINT_SHAPES) out = out.replace(shape, '<redacted>')
  return out
}
