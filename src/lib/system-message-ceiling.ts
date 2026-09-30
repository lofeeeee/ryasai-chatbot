/**
 * The provider's system-message ceiling — one shared budget, and the guards that hold our
 * prompts under it.
 *
 * ---------------------------------------------------------------------------
 * THE MEASURED CLIFF (this deployment's BYOK endpoint, 2026-09)
 * ---------------------------------------------------------------------------
 *
 * A `role: 'system'` message above roughly 2000 characters is DISCARDED WHOLE — not truncated,
 * not summarised. Reported `prompt_tokens` for an otherwise identical request:
 *
 *     1800 chars  -> 411   (system + user delivered)
 *     2100+ chars ->  44   (the user message alone)
 *
 * 3/3 reproducible in both directions, and a sweep of 1800/2000/2100/2200 placed the boundary
 * between 2000 and 2100. The SAME text in a `role: 'user'` message has no such ceiling: 12000
 * characters reports 1558 prompt_tokens and the instruction is still obeyed.
 *
 * This is silent-failure class 11/12 in `docs/silent-failure-classes.md`: an instruction that is
 * never DELIVERED looks exactly like a model ignoring it. It already cost this repo twice — the
 * Text-to-SQL rules (3033 chars) and the intent prompt (2872 chars) were dropped on EVERY request
 * while every symptom pointed at the model.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS NUMBER IS, AND IS NOT
 * ---------------------------------------------------------------------------
 *
 * It is a property of the CUSTOMER'S configured endpoint, not of our code and not of the OpenAI
 * spec. A different provider may have a different cliff, or none. So this is a BUDGET WE HOLD
 * OURSELVES TO, never something the transport enforces — nothing downstream checks it for us.
 *
 * It counts the JOINED system text, not one message at a time: an Anthropic-shaped request
 * concatenates every system message into a single `system` block
 * (`buildAnthropicBody` in `llm-client-anthropic.ts`), so three 700-character system messages are
 * one 2100-character system message on the wire. Budgeting the sum is the conservative reading,
 * and it is also the useful one: it stops a large org prefix from crowding out the fixed system
 * block that the answer depends on.
 *
 * `SYSTEM_MESSAGE_BUDGET` is deliberately BELOW the measured cliff. The exact boundary is only
 * known to lie between 2000 and 2100 on one endpoint, and a prompt that sits at 1999 spends its
 * whole life one edit away from being silently dropped.
 */

/** The measured cliff, in characters. See the file header — provider-specific, not a hard limit. */
export const PROVIDER_SYSTEM_MESSAGE_CEILING = 2000

/**
 * What we actually enforce. The headroom absorbs the fact that the cliff is only located to
 * within 100 characters, and that a future edit to any of these prompts is not a measurement.
 */
export const SYSTEM_MESSAGE_BUDGET = 1800

/** Join separator used by the Anthropic request builder when it merges system messages. */
const SYSTEM_JOIN = '\n\n'

export interface CeilingVerdict {
  ok: boolean
  /** Length of the text measured — the JOINED system text for the plural guard. */
  length: number
  ceiling: number
}

/**
 * Labels already warned about. A prompt that is over the ceiling on EVERY request must not print
 * a line every request — but it must print one, or the failure is invisible again.
 */
const warned = new Set<string>()

/** Test seam: forget which labels have warned, so a warning can be observed deterministically. */
export function resetSystemCeilingWarnings(): void {
  warned.clear()
}

function warnOnce(key: string, payload: Record<string, unknown>): void {
  if (warned.has(key)) return
  warned.add(key)
  // console.warn directly, NOT the structured logger: LOG_LEVEL can suppress a logger warning,
  // and "this instruction is being thrown away" is precisely the message that must not be
  // suppressible. The shape matches the logger's JSON lines so log tooling can still read it.
  console.warn(JSON.stringify({ level: 'warn', component: 'system-message-ceiling', ...payload }))
}

/** The system text as the wire will carry it: system messages joined, in order. */
export function systemTextLength(
  messages: ReadonlyArray<{ role: string; content: string }>,
): number {
  return messages
    .filter((m) => m.role === 'system')
    .map((m) => m.content)
    .join(SYSTEM_JOIN).length
}

/**
 * Guard ONE system message. Warns once per label when it is over the ceiling, and returns the
 * verdict so a caller can assert on it. Warn-only on purpose: the message was already being
 * dropped silently, and throwing here would turn a degraded prompt into a failed request.
 */
export function assertSystemPromptUnderCeiling(
  content: string,
  label: string,
  ceiling: number = PROVIDER_SYSTEM_MESSAGE_CEILING,
): CeilingVerdict {
  const length = content.length
  const ok = length <= ceiling
  if (!ok) {
    warnOnce(`single:${label}`, {
      msg: 'system message exceeds the provider ceiling and may be DISCARDED whole — move the rules to a USER message',
      label,
      length,
      ceiling,
      over: length - ceiling,
    })
  }
  return { ok, length, ceiling }
}

/**
 * Guard a whole message array the way the transport will send it (system text joined). This is
 * the backstop for prompts assembled from several pieces — a prefix plus a fixed block plus a
 * history label — where no single piece looks unreasonable and the total is over the line.
 */
export function assertSystemMessagesUnderCeiling(
  messages: ReadonlyArray<{ role: string; content: string }>,
  label: string,
  ceiling: number = PROVIDER_SYSTEM_MESSAGE_CEILING,
): CeilingVerdict {
  const length = systemTextLength(messages)
  const ok = length <= ceiling
  if (!ok) {
    warnOnce(`joined:${label}`, {
      msg: 'JOINED system text exceeds the provider ceiling and may be DISCARDED whole',
      label,
      length,
      ceiling,
      over: length - ceiling,
    })
  }
  return { ok, length, ceiling }
}

/** Would `content` fit as a system message alongside `reservedSystemText`? */
export function systemFitsBudget(
  content: string,
  reservedSystemText: string,
  budget: number = SYSTEM_MESSAGE_BUDGET,
): boolean {
  return content.length + reservedSystemText.length + SYSTEM_JOIN.length <= budget
}

/**
 * The org's configured prefix (`SavedPrompt.content`, `promptSettings.systemPrompt`, the rolling
 * session summary) as the message the transport should carry.
 *
 * WHY IT IS SOMETIMES DEMOTED TO A USER MESSAGE
 * --------------------------------------------
 * Its sources are UNBOUNDED server-side: `SavedPrompt.content` is validated as non-empty and
 * nothing more, the UI's 8000-character cap on `promptSettings.systemPrompt` is client-side, and
 * the session summary alone has been measured at ~2052 characters — over the cliff by itself. So
 * this function cannot assume the prefix is small.
 *
 * When it fits the remaining system budget it stays a SYSTEM message: it is the operator's
 * framing, carries the highest authority deliberately, and every existing behaviour (and test)
 * depends on it being first.
 *
 * When it does NOT fit, it is sent as a USER message carrying the SAME TEXT IN FULL. The reasons,
 * in order of weight:
 *   1. Truncating would DELETE operator instructions that arrived fine until the prefix grew —
 *      demotion loses nothing.
 *   2. It is the precedent this repo already set twice for the same defect
 *      (`docs/silent-failure-classes.md` #12): the Text-to-SQL RULES and the recall memory block
 *      are both user messages for exactly this reason.
 *   3. A user message is not a system message, so the fixed system block can never be crowded
 *      out by an oversize prefix.
 *
 * The follow-up that is NOT done here: neither `src/app/api/prompts/route.ts` nor
 * `mergePromptSettings` caps what an org may store. The bound belongs at the write path; it is
 * applied here, at the read path, because that is where the ceiling is observable.
 */
export function orgSystemPrefixMessage(
  prefix: string,
  label: string,
  reservedSystemText: string,
): { role: 'system' | 'user'; content: string } {
  if (systemFitsBudget(prefix, reservedSystemText)) {
    return { role: 'system', content: prefix }
  }
  warnOnce(`demoted:${label}`, {
    msg:
      'org system prompt prefix is over the system-message budget — sending it as a USER message ' +
      `(no ceiling) instead of letting the provider DISCARD a system message over ~${PROVIDER_SYSTEM_MESSAGE_CEILING} characters`,
    label,
    prefixLength: prefix.length,
    reservedSystemLength: reservedSystemText.length,
    budget: SYSTEM_MESSAGE_BUDGET,
  })
  return {
    role: 'user',
    content:
      'Operator instructions for this conversation (an organization-level system prompt). They are ' +
      'delivered as a user message because the provider discards a system message over ' +
      `~${PROVIDER_SYSTEM_MESSAGE_CEILING} characters whole, and this one is too long to share the ` +
      'system budget with the assistant instructions:\n\n' + prefix,
  }
}
