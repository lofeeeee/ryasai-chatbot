/**
 * The consolidated ALLOW/DENY layer for tool routing.
 * ----------------------------------------------------------------------------
 * WHY THIS MODULE EXISTS.
 *
 * Before this file the gating rules lived scattered across `tool-router.ts`:
 * `chooseAvailableDecision` downgraded a route whose SOURCE was absent,
 * `applyToolGating` additionally downgraded a route whose TOOL was toggled off
 * in prompt settings, and the two produced a bare `RouteDecision` with no
 * record of WHY. An operator reading an audit row could not tell "no database
 * is connected" from "you switched the SQL tool off", which are different
 * actions for different people. The LLM CHOOSES the tool (`tool-selector.ts`);
 * this layer is the single place that says whether that choice may run, per
 * requested source, with the reason attached.
 *
 * PURE AND SYNCHRONOUS BY DESIGN. It takes pre-fetched availability as
 * arguments, exactly as `applyToolGating` does — no DB, no env, no async — so it
 * can be evaluated in a test or an audit log without a live deployment.
 */
export type ToolAction = 'sql' | 'rag' | 'rest' | 'plugin' | 'chat' | 'contextual-chat'

/** What the caller already knows about this org, pre-fetched by `loadDbData`. */
export interface ToolPolicyInput {
  action: ToolAction
  available: { hasIntegrations: boolean; hasDocuments: boolean; hasRestApis: boolean }
  /** `promptSettings.tools`; optional and partially-set, because prompt-settings merges to all-on defaults. */
  tools?: { sql?: boolean; rag?: boolean; restApi?: boolean }
  /** The user pinned a database for this turn; recorded so the reason can distinguish a pin from an absence. */
  userPinnedIntegration?: boolean
  /** The user pinned the DOCUMENT corpus for this turn. */
  pinToDocuments?: boolean
  /** Extra tool ids the model requested beyond the first, on a compound question. */
  compoundExtraTools?: string[]
}

/** One ALLOW/DENY verdict per REQUESTED action, with the reason an operator can act on. */
export interface ToolPolicyDecision {
  action: ToolAction
  allowed: boolean
  reason: string
  /** The action that was requested and denied; present only on a downgrade. */
  downgradeFrom?: ToolAction
}

/**
 * The tool ids the unified catalogue and the selector emit, mapped to actions.
 *
 * WHY A MAP RATHER THAN GUESSING FROM THE NAME: `tool-selector.ts`'s
 * `routeForTool` documents the same rule — an exact-name table sent
 * `plugin:datetime` and `plugin:weather` to CHAT because the plugin set is
 * open-ended and installed at runtime, while the ROUTE set is closed. The
 * prefix arms mirror that decision so a `plugin:*` or `mcp:*` id requested as
 * an extra tool cannot be misread as `chat`.
 */
function actionForToolId(toolId: string): ToolAction {
  if (toolId === 'sql') return 'sql'
  if (toolId === 'rag') return 'rag'
  if (toolId === 'rest') return 'rest'
  if (toolId.startsWith('plugin:') || toolId.startsWith('mcp:')) return 'plugin'
  if (toolId === 'web_search' || toolId === 'web_fetch') return 'plugin'
  if (toolId === 'chat') return 'chat'
  if (toolId === 'contextual_chat' || toolId === 'contextual-chat') return 'contextual-chat'
  return 'chat'
}

/** The policy for ONE requested action. Kept separate from the fan-out below so the compound loop stays trivial. */
function evaluateOne(action: ToolAction, input: ToolPolicyInput): ToolPolicyDecision {
  switch (action) {
    case 'sql': {
      // Order mirrors applyToolGating: absence is checked FIRST, then the
      // operator toggle. Both can fail at once; the first reason is reported,
      // because a toggle cannot be observed for a source that is not there.
      if (!input.available.hasIntegrations) {
        return {
          action: 'chat',
          allowed: false,
          downgradeFrom: 'sql',
          reason:
            'SQL denied: no integration (database) is connected to this organization, so the sql tool has no source to query' +
            (input.userPinnedIntegration ? ' — the user pinned a database, but no integration is connected' : ''),
        }
      }
      if (input.tools?.sql === false) {
        return {
          action: 'chat',
          allowed: false,
          downgradeFrom: 'sql',
          reason: 'SQL denied: the sql tool is disabled (toggled off) in prompt settings',
        }
      }
      return { action: 'sql', allowed: true, reason: 'SQL allowed: an integration is connected and the sql tool is enabled' }
    }
    case 'rag': {
      if (!input.available.hasDocuments) {
        return {
          action: 'chat',
          allowed: false,
          downgradeFrom: 'rag',
          reason: input.pinToDocuments
            ? 'RAG denied: the user pinned documents and no document exists in this organization'
            : 'RAG denied: no document is uploaded to this organization, so the rag tool has nothing to retrieve',
        }
      }
      if (input.tools?.rag === false) {
        return {
          action: 'chat',
          allowed: false,
          downgradeFrom: 'rag',
          reason: 'RAG denied: the rag tool is disabled (toggled off) in prompt settings',
        }
      }
      return { action: 'rag', allowed: true, reason: 'RAG allowed: documents are present and the rag tool is enabled' }
    }
    case 'rest': {
      if (!input.available.hasRestApis) {
        return {
          action: 'chat',
          allowed: false,
          downgradeFrom: 'rest',
          reason: 'REST denied: no REST endpoint is configured for this organization, so the rest tool has nothing to call',
        }
      }
      if (input.tools?.restApi === false) {
        return {
          action: 'chat',
          allowed: false,
          downgradeFrom: 'rest',
          reason: 'REST denied: the rest tool is disabled (toggled off) in prompt settings',
        }
      }
      return { action: 'rest', allowed: true, reason: 'REST allowed: REST endpoints are configured and the rest tool is enabled' }
    }
    // PLUGIN, CHAT and CONTEXTUAL_CHAT are allowed unconditionally by
    // chooseAvailableDecision (its first two arms return the decision
    // unchanged), and applyToolGating has no toggle for them: prompt-settings
    // carries sql/rag/restApi toggles only.
    case 'plugin':
      return { action: 'plugin', allowed: true, reason: 'Plugin allowed: no precondition applies to the plugin route' }
    case 'chat':
      return { action: 'chat', allowed: true, reason: 'Chat allowed: no precondition applies to the chat route' }
    case 'contextual-chat':
      return { action: 'contextual-chat', allowed: true, reason: 'Contextual chat allowed: no precondition applies to the contextual-chat route' }
  }
}

/**
 * One decision per REQUESTED action: the primary, then each entry of
 * `compoundExtraTools` in the order the model requested them.
 *
 * WHY ONE PER REQUESTED SOURCE: a compound question may ask for several
 * sources, and each must be allowed or denied on its own — denying one half
 * must not silently deny (or grant) the other. The existing dispatch acts on
 * the primary decision, so a caller adopts this incrementally by reading
 * `decisions[0]` first and the remainder when it adopts compound routing.
 *
 * BEHAVIOUR-COMPATIBLE with `applyToolGating` for the single-tool case: for
 * every combination of availability and tool toggles, `decisions[0]`'s final
 * `action` equals what `applyToolGating` returns for the corresponding
 * `RouteDecision`. The agreement table in tool-policy.test.ts asserts this
 * against the real `chooseAvailableDecision` (the exported half of
 * `applyToolGating`), not against a copy of its rules.
 */
export function evaluateToolPolicy(input: ToolPolicyInput): ToolPolicyDecision[] {
  const requested: ToolAction[] = [input.action, ...(input.compoundExtraTools ?? []).map(actionForToolId)]
  return requested.map((action) => evaluateOne(action, input))
}
