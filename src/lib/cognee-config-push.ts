import { getMemoryLlmConfig } from '@/lib/llm-config'
import { getCogneeServerOptions } from '@/lib/cognee-core'
import { cogneeServerDiagnostics } from '@/lib/cognee-http'
import { scopedLogger } from '@/lib/logger'

/**
 * Push the org's provider configuration INTO the cognee sidecar.
 *
 * ─── WHAT THIS CAN AND CANNOT SHARE (measured against cognee 1.6.0, not assumed) ───
 *
 * The settings endpoint's `save_llm_config` writes ONLY `provider`, `model` and `api_key`:
 *
 *     llm_config.llm_provider = new_llm_config.provider
 *     llm_config.llm_model    = new_llm_config.model
 *     if ...: llm_config.llm_api_key = ...
 *
 * There is NO `endpoint` assignment anywhere in it, which is why a pushed endpoint comes back empty
 * from `GET /api/v1/settings` — verified: posting `endpoint: "http://example.test/v1"` stored `''`,
 * and the same for `api_base`, `baseUrl` and `apiEndpoint`. An OpenAI-compatible gateway that is not
 * api.openai.com therefore CANNOT be configured through this endpoint, however it is spelled.
 *
 * cognee DOES read `LLM_ENDPOINT` from its environment (`infrastructure/llm/config.py`), so the
 * endpoint is an ENV concern, not an API concern. This function shares what the API can carry and
 * REPORTS when the endpoint is missing, rather than pushing a value that will be silently dropped and
 * leaving the operator to discover it from a failure that names the wrong provider.
 *
 * THE PROBLEM THIS SOLVES. cognee runs its own extraction pipeline and therefore needs a chat model.
 * It cannot read the app's `LlmConfig` row (that is encrypted, and the sidecar has neither the key nor
 * a database connection), so until now the operator had to hand-copy the endpoint, model and API key
 * into `.env.cognee` and restart the sidecar. That is three chances to mistype a credential, and the
 * failure mode is a 30-second timeout that names the wrong cause.
 *
 * The app ALREADY HAS those credentials and already decrypts them for its own calls. Sharing them is
 * therefore a configuration COPY, not a new secret: same provider, same key, pushed over the internal
 * network to a sidecar that is part of the same install.
 *
 * WHY IT MUST RUN ON EVERY BOOT. cognee's settings endpoint is IN-MEMORY — measured: a pushed key
 * changed the runtime error from `LLMAPIKeyNotSetError` to a connection timeout, and a sidecar
 * restart brought `LLMAPIKeyNotSetError` back. So a one-time push is not enough; the sidecar forgets
 * on every restart, and a deployment that only pushed once would work until the first `docker compose
 * restart` and then silently stop extracting. Hence `pushCogneeProviderConfig()` is called at boot
 * AND after a settings save, and it is idempotent.
 *
 * FAIL-SOFT, LOUDLY. Memory is optional: if the push fails, chat must still work. It returns a result
 * the caller can surface rather than throwing, and logs at warn so an operator sees it — the failure
 * mode of this subsystem is a sidecar that reports `healthy` while storing nothing, which is exactly
 * what silence would hide.
 */

export interface CogneeProviderPushResult {
  ok: boolean
  /** What was pushed, for display. Never includes the key itself. */
  detail: string
  /** Present when `ok` is false. Operator-facing, and names the likely cause. */
  error?: string
  /**
   * True when the sidecar will NOT reach the app's endpoint, because cognee's settings API cannot
   * carry one. The push still succeeded for provider/model/key — this flags the remaining gap so the
   * caller can tell the operator what to do instead of reporting a success that will still fail.
   */
  endpointNeedsEnv?: boolean
  /** The value the operator must put in `.env.cognee`. Safe to display: it is a URL, not a secret. */
  endpointValue?: string
  /**
   * True when the sidecar's read-back disagrees with the model that was pushed, so the push landed but
   * the sidecar is not configured for the model we sent. `ok` is still true — provider and key were
   * accepted — and `error` carries the operator-facing explanation.
   */
  modelMismatch?: boolean
  /**
   * Which config the pushed credentials came from: the org's dedicated memory row, or the chat row it
   * falls back to. Returned rather than inferred so the operator can see WHICH model memory is
   * actually extracting with — the whole point of a separate memory config is being able to tell the
   * two states apart, and a screen that renders them identically makes the feature invisible.
   */
  source?: 'memory' | 'chat'
}

const log = scopedLogger('cognee-config-push')

/** Seconds to wait for the sidecar to accept a settings push. */
const PUSH_TIMEOUT_MS = 15_000

/**
 * Send the org's LLM credentials to the cognee sidecar.
 *
 * Returns `{ ok: false }` with a reason when there is nothing to push or the sidecar refuses — never
 * throws, because a memory problem must not take down the chat path that calls this at boot.
 */
export async function pushCogneeProviderConfig(): Promise<CogneeProviderPushResult> {
  const opts = await getCogneeServerOptions()
  if (!opts) {
    return { ok: false, detail: 'Memory is off (no COGNEE_SERVER_URL).', error: 'Memory is not configured.' }
  }

  const cfg = await getMemoryLlmConfig()
  if (!cfg) {
    // Nothing to share. This is a normal state, not an error: an install that has not configured a
    // provider yet cannot have memory extract anything, and the diagnostics panel already says so.
    return {
      ok: false,
      detail: 'No LLM configured in AI Configuration.',
      error: 'Set a provider in AI Configuration first — memory reuses it.',
    }
  }

  const url = `${opts.baseUrl.replace(/\/+$/, '')}/api/v1/settings`
  const body = {
    llm: {
      // cognee's litellm reads the provider from the model string, so the prefix is required. The
      // app's `provider` column is its own enum ('OPENAI_COMPATIBLE'), which litellm would not
      // understand as a provider name.
      provider: 'openai',
      model: cfg.model.startsWith('openai/') ? cfg.model : `openai/${cfg.model}`,
      endpoint: cfg.baseUrl,
      apiKey: cfg.apiKey,
    },
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), PUSH_TIMEOUT_MS)
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(opts.apiKey ? { Authorization: `Bearer ${opts.apiKey}` } : {}),
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      return {
        ok: false,
        detail: `Sidecar refused the settings push (HTTP ${res.status}).`,
        error: text.slice(0, 200) || 'The sidecar answered with an error.',
      }
    }
    // Read back what the sidecar actually stored. cognee's `save_llm_config` has no `endpoint`
    // assignment, so the endpoint is DROPPED — and reporting success without checking would leave the
    // operator with a sidecar that calls api.openai.com while the UI says the push worked.
    const stored = await readCogneeProviderConfig()

    /*
     * THE ENDPOINT WARNING WAS UNCONDITIONALLY TRUE, and it told an operator to add a line that was
     * already there.
     *
     * The old condition was `!stored.endpoint`, and `save_llm_config` NEVER assigns an endpoint —
     * MEASURED on the live sidecar, `GET /api/v1/settings` answers `"endpoint": ""` however correctly
     * the deployment is configured. So the warning fired on EVERY push, saying:
     *
     *     "Add OPENAI_API_BASE=https://proxy.ryasai.my.id/v1 to .env.cognee and restart the sidecar"
     *
     * The install it fired on already HAD that exact line, and its `llm_provider` component was
     * reporting `healthy / API responding` — the sidecar was reaching the proxy the whole time. A
     * warning that is always on carries no information and teaches an operator to ignore the case
     * that matters, which is worse than not warning at all.
     *
     * WHAT REPLACES IT IS A REAL MEASUREMENT, not a guess. This code cannot compare endpoints: the
     * read-back can never carry one, and the sidecar's `OPENAI_API_BASE` lives in a separate container
     * this app cannot read. But the sidecar's `/health/detailed` ACTIVELY TESTS its LLM provider and
     * reports the verdict, so that is what is asked — the one signal that can actually distinguish
     * "the endpoint is wrong" from "the endpoint is fine".
     *
     * `llm_provider` unhealthy is therefore reported WITH the endpoint remedy, because a provider that
     * cannot be reached is exactly when the OPENAI_API_BASE line is the likely fix. Healthy or unknown
     * reports nothing: silence is the correct answer when there is nothing wrong.
     */
    const diagnostics = await cogneeServerDiagnostics({
      baseUrl: opts.baseUrl,
      timeoutMs: opts.timeoutMs,
      apiKey: opts.apiKey,
    }).catch(() => null)
    const llmComponent = diagnostics?.components?.find((c) => c.name === 'llm_provider') ?? null
    const llmUnreachable = llmComponent !== null && llmComponent.status !== 'healthy'

    /*
     * THE MODEL READ-BACK IS THE OTHER HALF, and it was DISCARDED.
     *
     * `stored` was read for its `endpoint` alone; `stored.model` was fetched and thrown away, so this
     * function reported `Shared <model> at <endpoint>` whenever the POST returned 2xx — regardless of what
     * the sidecar actually kept. MEASURED against a stubbed settings endpoint: a sidecar answering
     * `{"llm":{"model":""}}` (nothing stored) and one answering a DIFFERENT model both produced
     * `ok: true, detail: "Shared openai/<the model we sent> at <endpoint>"`.
     *
     * That is this module's own stated failure mode — "a deployment that only pushed once would work until
     * the first `docker compose restart` and then silently stop extracting" — and it is the one an operator
     * cannot see: the toast and the COGNEE_PROVIDER_SHARED audit row both say the push landed, while the
     * sidecar extracts with the wrong model or none at all.
     *
     * `null` (unreadable) stays a clean success, deliberately: the tests below pin that, and inventing a
     * warning for a sidecar that merely did not answer the GET would fire on every push.
     */
    const modelMismatch = stored !== null && stored.model !== body.llm.model

    // Never echo the key. Naming the model and host is enough for an operator to confirm the push
    // landed, and a key in a log or a toast is a credential leak.
    // The detail names what the SIDECAR holds when it disagrees, so the reported state is reality rather
    // than intent — the same rule this module applies to the endpoint.
    //
    // THE HOST IS NAMED IN BOTH ARMS. It used to appear only in the clean case, so a model mismatch
    // dropped it — and the host is the one fact an operator uses to confirm the push went to the
    // deployment they meant. It is a URL, not a secret, which is why it is safe to echo.
    const detail = modelMismatch
      ? `Shared ${body.llm.model} at ${cfg.baseUrl}, but the sidecar reports ${stored.model || '(no model)'}`
      : `Shared ${body.llm.model} at ${cfg.baseUrl}`
    log.info('pushed provider config to cognee', {
      model: body.llm.model,
      endpoint: cfg.baseUrl,
      // The endpoint lives on the sidecar's side and is not verifiable from here, so it is logged as
      // the fact it is rather than through the old flag that was true on every single push.
      llmUnreachable,
      modelMismatch,
      source: cfg.source,
    })
    return {
      ok: true,
      detail,
      source: cfg.source,
      ...(modelMismatch
        ? {
            modelMismatch: true,
            // NOT `ok: false`: the provider and key were accepted, so calling this a failed push would
            // send an operator to retry a step that already worked. What is broken is the MODEL, which the
            // same settings API carries — so the fix is a retry or a sidecar restart, not an env var.
            error:
              `The sidecar reports model "${stored.model || ''}" after a push that sent "${body.llm.model}". ` +
              `It may have restarted (cognee keeps these settings in memory), or normalised the string. ` +
              `Push again, and check the sidecar's LLM configuration if it persists.`,
          }
        : {}),
      ...(llmUnreachable
        ? {
            endpointNeedsEnv: true,
            endpointValue: cfg.baseUrl,
            // This IS actionable, unlike the alarm it replaces: the sidecar's own health probe just
            // reported that it cannot use its LLM provider. The endpoint is the likeliest cause and the
            // one an operator can fix from outside the container, so the remedy is named — while the
            // message states the MEASURED fault rather than asserting where the sidecar will send
            // requests, which this code has no way to know.
            //
            // OPENAI_API_BASE is the variable to name: it reaches litellm with no startup cost, while
            // filling the three LLM_* vars slows the sidecar's boot from ~125s to ~150s+ (cognee
            // validates them at startup), and api_base="" does NOT override OPENAI_API_BASE.
            error:
              `The sidecar's LLM provider is ${llmComponent?.status ?? 'unusable'}` +
              `${llmComponent?.details ? ` (${llmComponent.details})` : ''}. ` +
              `Its endpoint is configured separately from these credentials, in .env.cognee as ` +
              `OPENAI_API_BASE=${cfg.baseUrl} — the settings API cannot carry it. Check that line, ` +
              `then restart the sidecar.`,
          }
        : {}),
    }
  } catch (e) {
    const aborted = e instanceof Error && e.name === 'AbortError'
    return {
      ok: false,
      detail: aborted ? 'Sidecar did not answer in time.' : 'Sidecar unreachable.',
      error: aborted
        ? 'The memory sidecar is not responding. Check that the cognee container is running.'
        : 'Could not reach the memory sidecar on the internal network.',
    }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Read back what the sidecar currently believes its model is.
 *
 * Used to show the operator the TRUTH rather than the intent: a push can be accepted and then lost to
 * a restart, and the only way to know which is to ask the sidecar. Null when it cannot be read.
 */
export async function readCogneeProviderConfig(): Promise<{ model: string; endpoint: string } | null> {
  const opts = await getCogneeServerOptions()
  if (!opts) return null
  const url = `${opts.baseUrl.replace(/\/+$/, '')}/api/v1/settings`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 8000)
  try {
    const res = await fetch(url, {
      headers: opts.apiKey ? { Authorization: `Bearer ${opts.apiKey}` } : {},
      signal: controller.signal,
    })
    if (!res.ok) return null
    const json = (await res.json()) as { llm?: { model?: string; endpoint?: string } }
    return { model: json?.llm?.model ?? '', endpoint: json?.llm?.endpoint ?? '' }
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}
