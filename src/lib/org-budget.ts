/**
 * Per-org daily LLM budget — a dormant operator SAFETY VALVE, not billing.
 * ----------------------------------------------------------------------------
 * Sibling of `llm-budget.ts`, which caps the whole PROCESS via
 * LLM_DAILY_TOKEN_BUDGET. This one is per-ORGANIZATION and caps two counters
 * per UTC day: tokens (prompt + completion summed over LlmUsageLog) and
 * requests (usage rows logged that day).
 *
 * Deliberately OFF by default, and deliberately NOT a metering or billing
 * mechanism: the install is on-prem, the signed license is the entitlement,
 * and the customer pays their own LLM provider (AGENTS.md "Deployment model").
 * Like `assertWithinBudget`, the only job of these caps is to stop a runaway
 * agent loop from burning one org's provider quota.
 *
 * Returns a DECISION instead of throwing so the caller can map it to HTTP 429
 * itself; `orgBudgetExceededMessage` is the ready-made response body.
 *
 * ponytail: nothing imports this yet — wiring is out of scope here, so the
 * valve stays dormant until a caller opts in.
 */
import { db } from '@/lib/db'

/**
 * How long a usage snapshot may be reused. One chat turn makes several LLM
 * calls, each of which would otherwise re-run the same aggregate for the same
 * org — a burst must not pay a DB round trip per call. Short (not minutes)
 * because the snapshot also lags behind rows written mid-turn: a decision can
 * be up to this many milliseconds stale in the "under limit" direction.
 */
export const ORG_BUDGET_CACHE_TTL_MS = 5_000

export interface OrgBudgetConfig {
  /** Max tokens (prompt + completion) per org per UTC day. 0 = unlimited. */
  tokens: number
  /** Max logged LLM calls per org per UTC day. 0 = unlimited. */
  requests: number
}

export interface OrgBudgetDecision {
  limited: boolean
  /** Which cap was exhausted — only set when `limited` is true. */
  reason?: 'tokens' | 'requests'
  tokensUsed: number
  requestsUsed: number
  /** 0 means "no token cap configured". */
  tokensLimit: number
  /** 0 means "no request cap configured". */
  requestsLimit: number
}

type EnvSource = Record<string, string | undefined>

/** Above this many cached orgs, drop expired entries instead of growing forever. */
const ORG_BUDGET_CACHE_MAX_ENTRIES = 1_000

interface OrgBudgetCacheEntry {
  expiresAt: number
  /** Limits the snapshot was taken under — a mismatch is a miss, not a hit. */
  limits: OrgBudgetConfig
  decision: OrgBudgetDecision
}

const orgBudgetCache = new Map<string, OrgBudgetCacheEntry>()

/** Test hook: drop cached snapshots so the next check re-queries. */
export function clearOrgBudgetCache(): void {
  orgBudgetCache.clear()
}

/**
 * Env value → limit. Unset, non-positive or non-finite → 0 = unlimited, so a
 * typo'd budget DISABLES the valve instead of limiting every request.
 *
 * ponytail: parseFloat, not parseInt — `parseInt('1e6') === 1` would turn an
 * operator's "a million" into a one-token cap and refuse every call.
 */
function parseBudget(raw: string | undefined): number {
  if (!raw) return 0
  const parsed = Number.parseFloat(raw)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0
}

/** Pure read of the two env knobs, so tests never need process.env. */
export function getOrgBudgetConfig(env: EnvSource = process.env): OrgBudgetConfig {
  return {
    tokens: parseBudget(env.ORG_DAILY_TOKEN_BUDGET),
    requests: parseBudget(env.ORG_DAILY_REQUEST_BUDGET),
  }
}

/** Midnight UTC of the day containing `now` — the budget window is the UTC day. */
function startOfTodayUtc(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
}

function cacheDecision(organizationId: string, limits: OrgBudgetConfig, decision: OrgBudgetDecision): void {
  if (orgBudgetCache.size >= ORG_BUDGET_CACHE_MAX_ENTRIES) {
    const nowMs = Date.now()
    for (const [key, entry] of orgBudgetCache) {
      if (entry.expiresAt <= nowMs) orgBudgetCache.delete(key)
    }
    // All entries still fresh (a burst across >1000 orgs within 5 s) — start over
    // rather than grow without bound; each affected org re-queries once.
    if (orgBudgetCache.size >= ORG_BUDGET_CACHE_MAX_ENTRIES) orgBudgetCache.clear()
  }
  orgBudgetCache.set(organizationId, {
    expiresAt: Date.now() + ORG_BUDGET_CACHE_TTL_MS,
    limits,
    decision,
  })
}

/**
 * Today's token spend and logged-call count for one org, compared against the
 * caps. ONE aggregate query answers both counters.
 *
 * When both caps are unlimited (the default), it returns WITHOUT touching the
 * database at all — this runs on every chat turn, and an unconfigured install
 * must not pay a DB round trip for a check that can only say "no limit".
 *
 * A DB failure propagates rather than being swallowed: reporting
 * `limited: false` with fabricated zero usage would be a false "within budget"
 * (the silent-failure class AGENTS.md warns about), and this valve is a read —
 * failing the request is the safe direction for a limiter.
 */
export async function checkOrgBudget(
  organizationId: string,
  config?: OrgBudgetConfig,
): Promise<OrgBudgetDecision> {
  const cfg = config ?? getOrgBudgetConfig()
  const tokensLimit = Number.isFinite(cfg.tokens) && cfg.tokens > 0 ? cfg.tokens : 0
  const requestsLimit = Number.isFinite(cfg.requests) && cfg.requests > 0 ? cfg.requests : 0

  if (tokensLimit === 0 && requestsLimit === 0) {
    return { limited: false, tokensUsed: 0, requestsUsed: 0, tokensLimit: 0, requestsLimit: 0 }
  }

  const cached = orgBudgetCache.get(organizationId)
  if (
    cached &&
    cached.expiresAt > Date.now() &&
    cached.limits.tokens === tokensLimit &&
    cached.limits.requests === requestsLimit
  ) {
    return cached.decision
  }

  const usage = await db.llmUsageLog.aggregate({
    where: {
      organizationId,
      createdAt: { gte: startOfTodayUtc(new Date()) },
    },
    // Sum the parts rather than `totalTokens`: the write path logs a row
    // whenever prompt OR completion tokens were reported, even when the
    // provider sent no total — summing `totalTokens` undercounts those.
    _sum: { promptTokens: true, completionTokens: true },
    // Rows logged today ≈ requests; a call that reported no usage writes no
    // row and so is not counted. Documented approximation, same source either way.
    _count: true,
  })

  const tokensUsed = (usage._sum.promptTokens ?? 0) + (usage._sum.completionTokens ?? 0)
  const requestsUsed = usage._count ?? 0

  // ponytail: >=, not > — a budget fully consumed is already spent, so the
  // next call is refused. Matches `assertWithinBudget`'s `used >= tokenCap`.
  const limitedByTokens = tokensLimit > 0 && tokensUsed >= tokensLimit
  const limitedByRequests = requestsLimit > 0 && requestsUsed >= requestsLimit
  const reason: 'tokens' | 'requests' | undefined = limitedByTokens
    ? 'tokens'
    : limitedByRequests
      ? 'requests'
      : undefined

  const decision: OrgBudgetDecision = {
    limited: limitedByTokens || limitedByRequests,
    reason,
    tokensUsed,
    requestsUsed,
    tokensLimit,
    requestsLimit,
  }
  cacheDecision(organizationId, { tokens: tokensLimit, requests: requestsLimit }, decision)
  return decision
}

/**
 * Refusal text for an HTTP 429 body. Empty string when the decision is NOT
 * limited — callers gate on `decision.limited` before using this.
 */
export function orgBudgetExceededMessage(decision: OrgBudgetDecision): string {
  if (!decision.limited) return ''
  if (decision.reason === 'requests') {
    return `Your organization has reached its daily limit of ${decision.requestsLimit} requests (${decision.requestsUsed} used today). Please try again after the limit resets at midnight UTC or contact your administrator.`
  }
  return `Your organization has reached its daily limit of ${decision.tokensLimit} tokens (${decision.tokensUsed} used today). Please try again after the limit resets at midnight UTC or contact your administrator.`
}
