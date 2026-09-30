/**
 * Lightweight LLM observability — in-memory ring buffer of recent traces,
 * with optional fire-and-forget forwarding to Langfuse / Helicone.
 *
 * TENANT SCOPING IS THE READER'S JOB HERE, and that is the trap this file records.
 * `traces` below is a MODULE GLOBAL shared by every org in the process, and it is
 * NOT a Prisma query — so `enterWithOrg()` cannot scope it the way the tenant
 * extension scopes `db.*`. `enterWithOrg` only writes AsyncLocalStorage; THIS module
 * must read that context and apply the filter itself. Two routes called
 * `enterWithOrg((await getActiveUser()).organizationId)` and then read the whole
 * buffer, so `tenant-route-guard.test.ts` passed them while any authenticated user
 * of any org could read every tenant's prompt bodies and answers.
 *
 * The rule: every entry is stamped with an `organizationId` at write time, and every
 * reader filters on it. A caller's ritual does not scope anything by itself.
 */
export interface LlmTrace {
  id: string
  /**
   * The org this trace belongs to, stamped from `getOrgContext()` inside
   * `traceLlmCall` — never passed by the caller, so no call site can mislabel a
   * trace (or hand one org's payload to another). See `NO_ORG_TRACE_SCOPE` for the
   * value used when there is no org context at all.
   */
  organizationId: string
  purpose: string
  provider: string
  model: string
  inputPreview: string
  outputPreview: string
  toolCalls?: Array<{ name: string; arguments: string }>
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number }
  latencyMs: number
  timestamp: Date
  error?: string
  metadata?: Record<string, unknown>
}

/**
 * Stamp for a trace recorded with NO org context (background work outside a job's
 * `enterWithOrg`, boot-time seeding, unit tests).
 *
 * DECISION — record it rather than drop it. Refusing to record would silently discard
 * the evidence of exactly the calls that run without an org context, which are the
 * ones an operator most needs to see when debugging an install; the trace also stays
 * useful for the Langfuse/Helicone forward. The risk of recording is answered by
 * filtering instead of by refusing: this sentinel is not a real `Organization.id`
 * (cuid) and the readers only ever return a scope on EQUALITY, so no tenant can
 * retrieve a sentinel trace. The only reader that can see one is a reader that itself
 * has no org context — i.e. code that is not acting for any tenant.
 */
export const NO_ORG_TRACE_SCOPE = '__no-org-context__'

const RING_MAX = 100
// ponytail: in-memory ring buffer — lost on restart. Fine for production debugging;
// persistent storage is the LlmUsageLog table, external tracers cover long-term.
// Ceiling: the 100 slots are shared by ALL orgs, so a busy org evicts a quiet org's
// traces. That is a fidelity limit, not a leak — the readers filter by org, so an
// evicted trace is gone rather than handed to the wrong tenant.
const traces: LlmTrace[] = []

import { getOrgContext } from './prisma-tenant'
import { inc, observe, counter } from './metrics'
counter('llm_errors_total', 'Total LLM call errors')

/**
 * Resolve the org a read applies to.
 *
 * An explicit argument wins over the ambient context, but a disagreement between the
 * two is REFUSED rather than honoured: if AsyncLocalStorage says org A and a caller
 * passes org B, the only way that happens is a caller trusting an org id it did not
 * derive from the session — the client-supplied-id shape of the 2026-09 IDOR. An
 * empty result is the fail-closed answer, and it is indistinguishable from a buffer
 * that holds nothing for that org, which is the point.
 */
function traceScopeFor(explicit?: string): string | null {
  const ambient = getOrgContext()
  if (explicit !== undefined && ambient !== undefined && explicit !== ambient) return null
  return explicit ?? ambient ?? NO_ORG_TRACE_SCOPE
}

export function traceLlmCall(trace: Omit<LlmTrace, 'id' | 'timestamp' | 'organizationId'>): string {
  const entry: LlmTrace = {
    ...trace,
    // Stamped HERE, from the context — the type omits it so a call site cannot set it.
    organizationId: getOrgContext() ?? NO_ORG_TRACE_SCOPE,
    id: crypto.randomUUID(),
    timestamp: new Date(),
  }
  if (traces.length >= RING_MAX) traces.shift()
  traces.push(entry)
  forwardTrace(entry).catch(() => {})
  inc('llm_calls_total', { provider: trace.provider, purpose: trace.purpose })
  observe('llm_duration_seconds', trace.latencyMs / 1000, { purpose: trace.purpose })
  if (trace.usage) {
    inc('llm_tokens_total', { provider: trace.provider }, trace.usage.totalTokens)
  }
  if (trace.error) {
    inc('llm_errors_total', { provider: trace.provider })
  }
  return entry.id
}

/**
 * Recent traces FOR ONE ORG, most-recent-first.
 *
 * `organizationId` is optional only so a caller inside an org context (the routes,
 * via `enterWithOrg`) does not have to repeat what AsyncLocalStorage already holds;
 * when omitted the scope comes from `getOrgContext()`. It is NOT an unscoped read:
 * with no org anywhere the scope falls back to the no-org sentinel, which returns
 * the org-less traces and never another tenant's.
 */
export function getRecentTraces(limit: number = 50, organizationId?: string): LlmTrace[] {
  const scope = traceScopeFor(organizationId)
  if (scope === null) return []
  // ponytail: equality against the stamped scope, so a trace is never returned to an
  // org that did not record it. The no-org sentinel is safe for the same reason: an
  // org id can never equal it.
  return traces.filter((t) => t.organizationId === scope).slice(-limit).reverse()
}

export function getTraceStats(organizationId?: string): {
  totalCalls: number
  avgLatencyMs: number
  errorRate: number
  totalTokens: number
} {
  const scope = traceScopeFor(organizationId)
  // Fail closed on a scope disagreement: zeroes, not the whole buffer's numbers.
  const scoped = scope === null ? [] : traces.filter((t) => t.organizationId === scope)
  const n = scoped.length
  if (n === 0) return { totalCalls: 0, avgLatencyMs: 0, errorRate: 0, totalTokens: 0 }
  const totalLatency = scoped.reduce((s, t) => s + t.latencyMs, 0)
  const errors = scoped.filter((t) => t.error).length
  const tokens = scoped.reduce((s, t) => s + (t.usage?.totalTokens ?? 0), 0)
  return {
    totalCalls: n,
    avgLatencyMs: Math.round(totalLatency / n),
    errorRate: errors / n,
    totalTokens: tokens,
  }
}

// ponytail: fire-and-forget forwarding — never blocks the LLM call.
// Failures are warned to console and swallowed; the in-memory buffer is the source of truth.
/**
 * Log forwarding must never slow down the thing it observes, so the deadline is SHORTER than
 * the login and LLM paths: 5s. Every one of these calls already sits in a try/catch that only
 * warns, so a timeout degrades to "this trace was not forwarded" rather than a failure. A hung
 * collector socket would otherwise keep the request open and, on a slow network, let
 * observability turn into an outage amplifier.
 */
function observabilityTimeoutMs(): number {
  const raw = Number(process.env.OBSERVABILITY_TIMEOUT_MS)
  return Number.isFinite(raw) && raw > 0 ? raw : 5_000
}

/** Test-only accessor; see the note on `oidcTimeoutMs` in sso.ts. */
export const __observabilityTimeoutMsForTest = observabilityTimeoutMs

async function forwardTrace(t: LlmTrace): Promise<void> {
  const langfuseKey = process.env.LANGFUSE_PUBLIC_KEY
  const langfuseSecret = process.env.LANGFUSE_SECRET_KEY
  const langfuseBase = process.env.LANGFUSE_BASEURL ?? 'https://cloud.langfuse.com'
  const heliconeKey = process.env.HELICONE_API_KEY

  if (langfuseKey && langfuseSecret) {
    try {
      const start = t.timestamp
      const end = new Date(t.timestamp.getTime() + t.latencyMs)
      await fetch(`${langfuseBase}/api/public/ingestion`, {
        method: 'POST',
        signal: AbortSignal.timeout(observabilityTimeoutMs()),
        headers: {
          'Content-Type': 'application/json',
          Authorization:
            'Basic ' + Buffer.from(`${langfuseKey}:${langfuseSecret}`).toString('base64'),
        },
        body: JSON.stringify({
          batch: [
            {
              id: t.id,
              type: 'generation-create',
              body: {
                id: t.id,
                traceId: t.id,
                name: t.purpose,
                startTime: start.toISOString(),
                endTime: end.toISOString(),
                model: t.model,
                input: t.inputPreview,
                output: t.outputPreview,
                usage: t.usage
                  ? {
                      promptTokens: t.usage.promptTokens,
                      completionTokens: t.usage.completionTokens,
                    }
                  : undefined,
                metadata: { ...(t.metadata ?? {}), ...(t.error ? { error: t.error } : {}) },
              },
            },
          ],
        }),
      })
    } catch (e) {
      console.warn('[observability] langfuse forward failed:', e)
    }
  }

  if (heliconeKey) {
    try {
      await fetch('https://api.hconeai.com/v1/log', {
        method: 'POST',
        signal: AbortSignal.timeout(observabilityTimeoutMs()),
        headers: {
          'Content-Type': 'application/json',
          'Helicone-Auth': `Bearer ${heliconeKey}`,
        },
        body: JSON.stringify({
          id: t.id,
          purpose: t.purpose,
          provider: t.provider,
          model: t.model,
          input: t.inputPreview,
          output: t.outputPreview,
          latencyMs: t.latencyMs,
          usage: t.usage,
          error: t.error,
        }),
      })
      } catch (e) {
      console.warn('[observability] helicone forward failed:', e)
    }
  }
}

/**
 * Post an evaluation score (e.g. RAGAS metric) to Langfuse. Fire-and-forget —
 * never blocks the caller. No-op when Langfuse env vars are not set.
 */
export async function postLangfuseScore(args: {
  name: string
  value: number
  comment?: string
  traceId?: string
}): Promise<void> {
  const langfuseKey = process.env.LANGFUSE_PUBLIC_KEY
  const langfuseSecret = process.env.LANGFUSE_SECRET_KEY
  const langfuseBase = process.env.LANGFUSE_BASEURL ?? 'https://cloud.langfuse.com'

  if (!langfuseKey || !langfuseSecret) return

  try {
    await fetch(`${langfuseBase}/api/public/scores`, {
      method: 'POST',
      signal: AbortSignal.timeout(observabilityTimeoutMs()),
      headers: {
        'Content-Type': 'application/json',
        Authorization:
          'Basic ' + Buffer.from(`${langfuseKey}:${langfuseSecret}`).toString('base64'),
      },
      body: JSON.stringify({
        name: args.name,
        value: args.value,
        comment: args.comment,
        traceId: args.traceId,
      }),
    })
  } catch (e) {
    console.warn('[observability] langfuse score post failed:', e)
  }
}
