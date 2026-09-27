import { getLlmRuntimeConfig } from '@/lib/llm-config'
import { getCogneeServerOptions } from '@/lib/cognee-core'
import { scopedLogger } from '@/lib/logger'

/**
 * Push the org's provider configuration INTO the cognee sidecar.
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

  const cfg = await getLlmRuntimeConfig()
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
    // Never echo the key. Naming the model and host is enough for an operator to confirm the push
    // landed, and a key in a log or a toast is a credential leak.
    const detail = `Shared ${body.llm.model} at ${cfg.baseUrl}`
    log.info('pushed provider config to cognee', { model: body.llm.model, endpoint: cfg.baseUrl })
    return { ok: true, detail }
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
