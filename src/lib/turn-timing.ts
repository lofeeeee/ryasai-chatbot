/**
 * Per-turn latency breakdown — answers "where did the wait go?" for ONE chat turn.
 *
 * WHY THIS EXISTS
 * ----------------------------------------------------------------------------
 * `llm_duration_seconds` and `LlmUsageLog.latencyMs` describe each LLM call in
 * isolation, and `rag_retrieval_latency_ms` describes one retrieval. Neither says
 * how many sequential calls a turn made before the first token or how much of the
 * pre-token wait they account for. That figure is what decides whether a latency
 * change is worth its accuracy risk, so it is measured here rather than estimated.
 *
 * HOW IT IS COLLECTED
 * ----------------------------------------------------------------------------
 * The send route opens a collector with `enterTurnTiming()`; `logLlmUsage` reports
 * every LLM call into it via `recordTurnLlmCall()` (the one place all calls pass
 * through, so no call site can forget to report). Outside a turn (scheduler,
 * background jobs) there is no collector and the report is a no-op.
 *
 * Observability must never break the turn it observes: every entry point swallows
 * its own failure.
 */
import { AsyncLocalStorage } from 'node:async_hooks'
// A namespace import, for the same reason as rag-metrics.ts: `metrics.ts` is mocked
// with a partial surface in other test files, and a missing named export would throw
// at module-evaluation time in a file that never asked for it.
import * as metrics from './metrics'

interface LlmCallSample {
  purpose: string
  /** How long the call took. */
  ms: number
  /** When the call FINISHED, as an offset from the start of the turn. */
  endedAtMs: number
}

interface TurnCollector {
  startedAt: number
  calls: LlmCallSample[]
}

const storage = new AsyncLocalStorage<TurnCollector>()

export const TURN_FIRST_TOKEN_METRIC = 'chat_first_token_ms'
export const TURN_TOTAL_METRIC = 'chat_turn_total_ms'
export const TURN_PRE_TOKEN_LLM_CALLS_METRIC = 'chat_pre_token_llm_calls'

const LATENCY_BUCKETS_MS = [500, 1000, 2000, 4000, 8000, 15000, 30000, 60000, 120000]
const CALL_BUCKETS = [0, 1, 2, 3, 4, 5, 6, 8, 12]

/**
 * Start collecting for the current async context.
 *
 * `enterWith` rather than `run`: the send route's `start()` is one long closure and
 * re-indenting it into a callback would turn this into a whole-file diff. The
 * context lives for the rest of that async execution, which is exactly the turn.
 */
export function enterTurnTiming(now: number = Date.now()): void {
  try {
    storage.enterWith({ startedAt: now, calls: [] })
  } catch {
    /* never break the turn */
  }
}

/** Called by `logLlmUsage` for every LLM call. No-op outside a turn. */
export function recordTurnLlmCall(purpose: string, latencyMs: number, now: number = Date.now()): void {
  try {
    const turn = storage.getStore()
    if (!turn) return
    turn.calls.push({ purpose, ms: Math.max(0, Math.round(latencyMs)), endedAtMs: now - turn.startedAt })
  } catch {
    /* never break the turn */
  }
}

export interface TurnTimings {
  /** Request start to the first answer token. */
  firstTokenMs: number
  totalMs: number
  /** LLM calls that FINISHED before the first token was produced. */
  preTokenLlmCalls: number
  /** Sum of those calls' durations — the sequential LLM wait in front of the user. */
  preTokenLlmMs: number
  /** Everything before the first token that was NOT one of those LLM calls (DB, recall, retrieval, queueing). */
  preTokenOtherMs: number
  /** Per-purpose totals, so the heaviest stage is named rather than inferred. */
  byPurpose: Record<string, { calls: number; ms: number }>
}

/**
 * Summarise the turn that is running in this context, or null when none is.
 *
 * `firstTokenAt === null` means no token was produced (error or empty answer); the
 * pre-token figures then cover the whole turn, which is what the user actually waited.
 */
export function summarizeTurn(firstTokenAt: number | null, now: number = Date.now()): TurnTimings | null {
  try {
    const turn = storage.getStore()
    if (!turn) return null
    const totalMs = Math.max(0, now - turn.startedAt)
    const firstTokenMs = Math.max(0, (firstTokenAt ?? now) - turn.startedAt)
    const pre = turn.calls.filter((c) => c.endedAtMs <= firstTokenMs)
    const preTokenLlmMs = pre.reduce((s, c) => s + c.ms, 0)
    const byPurpose: TurnTimings['byPurpose'] = {}
    for (const c of turn.calls) {
      const slot = (byPurpose[c.purpose] ??= { calls: 0, ms: 0 })
      slot.calls += 1
      slot.ms += c.ms
    }
    return {
      firstTokenMs,
      totalMs,
      preTokenLlmCalls: pre.length,
      preTokenLlmMs,
      // Clamped: calls can overlap (parallel), so their durations can sum past the wall clock.
      preTokenOtherMs: Math.max(0, firstTokenMs - preTokenLlmMs),
      byPurpose,
    }
  } catch {
    return null
  }
}

/** Feed the Prometheus histograms. Registers on first use so a fresh process records from turn one. */
export function recordTurnMetrics(t: TurnTimings): void {
  try {
    metrics.histogram?.(TURN_FIRST_TOKEN_METRIC, 'Request start to first answer token, in milliseconds', LATENCY_BUCKETS_MS)
    metrics.histogram?.(TURN_TOTAL_METRIC, 'Whole chat turn duration in milliseconds', LATENCY_BUCKETS_MS)
    metrics.histogram?.(TURN_PRE_TOKEN_LLM_CALLS_METRIC, 'LLM calls completed before the first token', CALL_BUCKETS)
    metrics.observe?.(TURN_FIRST_TOKEN_METRIC, t.firstTokenMs)
    metrics.observe?.(TURN_TOTAL_METRIC, t.totalMs)
    metrics.observe?.(TURN_PRE_TOKEN_LLM_CALLS_METRIC, t.preTokenLlmCalls)
  } catch {
    /* never break the turn */
  }
}
