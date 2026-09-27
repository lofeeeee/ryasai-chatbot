'use client'

import { useCallback, useEffect, useState } from 'react'
import { AlertTriangle, CheckCircle2, Loader2, RefreshCw, Share2 } from 'lucide-react'
import { toast } from 'sonner'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'

/**
 * Share the app's provider configuration with the memory sidecar.
 *
 * WHY THIS IS A SHARE AND NOT A SECOND CONFIG FORM. cognee needs its own chat model, and it cannot
 * read the app's `LlmConfig` row — that is encrypted, and the sidecar holds neither the key nor a DB
 * connection. Before this, the only way to give it credentials was to hand-copy the endpoint, model
 * and API key into `.env.cognee` and restart the sidecar: three chances to mistype a secret, and a
 * failure that surfaces as a 30-second timeout naming the wrong cause.
 *
 * The app ALREADY has those credentials and already decrypts them for its own calls, so sharing them
 * is a configuration copy rather than a new secret. One place to set the provider, both consumers
 * using it — and if you change the model in AI Configuration, one click (or the next restart)
 * propagates it instead of a silent drift between the two.
 *
 * THE SIDECAR FORGETS. cognee's settings endpoint is in-memory: measured, a pushed key changed the
 * runtime error from `LLMAPIKeyNotSetError` to a connection timeout, and a restart brought
 * `LLMAPIKeyNotSetError` back. So the app re-pushes at every boot — this panel exists for the case
 * where an operator wants to push NOW, and for showing whether the push actually landed.
 */
export function MemoryProviderPanel() {
  const [busy, setBusy] = useState(false)
  const [actual, setActual] = useState<{ model: string; endpoint: string } | null>(null)
  const [shared, setShared] = useState<{ detail: string } | null>(null)

  /** Read what the sidecar BELIEVES, not what we last sent. A push can be lost to a restart. */
  const refresh = useCallback(async () => {
    try {
      const res = await fetch('/api/cognee/provider', { cache: 'no-store' })
      const json = await res.json()
      if (json?.ok) {
        setActual(json.data?.configured ?? null)
        if (json.data?.shared) setShared({ detail: json.data.shared })
      }
    } catch {
      // Non-fatal: the panel shows "unknown" rather than a verdict it cannot support.
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const push = async () => {
    setBusy(true)
    try {
      const res = await fetch('/api/cognee/provider', { method: 'POST' })
      const json = await res.json()
      if (!res.ok || !json.ok) {
        toast.error('Could not share the provider', { description: json?.error?.message ?? json?.detail })
        return
      }
      if (json.data?.endpointNeedsEnv) {
        /*
         * SUCCESS WITH A REMAINING GAP, and it must not be reported as a plain success.
         *
         * cognee's settings API stores provider/model/key but has NO endpoint field (read from its
         * `save_llm_config`), so a gateway is unreachable that way. Saying "shared" alone would send
         * the operator away thinking memory works, and the next failure would name the wrong provider.
         * The remedy is shown with the exact value to paste.
         */
        toast.warning('Provider shared — one manual step left', {
          duration: 20000,
          description: json.data.warning ?? `Set LLM_ENDPOINT=${json.data.endpointValue} in .env.cognee`,
        })
      } else {
        toast.success('Provider shared with memory', { description: json.data?.detail })
      }
      await refresh()
    } catch (e) {
      toast.error('Could not share the provider', {
        description: e instanceof Error ? e.message : undefined,
      })
    } finally {
      setBusy(false)
    }
  }

  const inSync = Boolean(actual?.model && shared && actual.model === shared.detail.match(/openai\/\S+/)?.[0])

  return (
    <div className="space-y-2 rounded-md border border-border/70 bg-muted/20 p-2.5">
      <div className="flex items-center gap-1.5">
        <Share2 className="h-3.5 w-3.5 text-muted-foreground" />
        <div className="text-xs font-medium">Memory Provider</div>
        {actual?.model ? (
          inSync ? (
            <Badge variant="outline" className="text-[10px]">
              <CheckCircle2 className="mr-1 h-2.5 w-2.5 text-success" />
              shared
            </Badge>
          ) : (
            <Badge variant="secondary" className="text-[10px]">
              re-share needed
            </Badge>
          )
        ) : (
          <Badge variant="outline" className="text-[10px] text-muted-foreground">
            not set
          </Badge>
        )}
      </div>

      <p className="text-[10px] text-muted-foreground">
        Memory reuses the model from <strong>AI Configuration</strong> — one place to set it, both
        consumers using it. The sidecar keeps this in memory only, so the app re-shares it at every
        restart. Share now if you just changed the provider.
      </p>

      {/*
        Show what the SIDECAR reports, not what the app intends. Intent and reality diverge here
        precisely because the config is in-memory, and a panel that showed the app's own value would
        report success for a sidecar that had already forgotten it.
      */}
      <div className="space-y-0.5 font-mono text-[10px]">
        {actual?.model ? (
          <>
            <div>model: {actual.model}</div>
            <div className="text-muted-foreground">endpoint: {actual.endpoint || '(empty)'}</div>
          </>
        ) : (
          <div className="flex items-start gap-1.5 font-sans text-muted-foreground">
            <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0 text-warning" />
            <span>
              The sidecar reports no model. Memory writes will fail even though the container is
              healthy — that is the failure this panel exists to make visible.
            </span>
          </div>
        )}
      </div>

      <div className="flex items-center gap-2">
        <Button
          size="sm"
          className="h-7 text-xs"
          icon={busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Share2 className="h-3.5 w-3.5" />}
          onClick={push}
          disabled={busy}
        >
          Share provider now
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="h-7 text-xs"
          icon={<RefreshCw className="h-3.5 w-3.5" />}
          onClick={() => void refresh()}
          disabled={busy}
        >
          Re-read
        </Button>
        <Label className="ml-auto text-[10px] font-normal text-muted-foreground">
          Set the model in AI Configuration → LLM
        </Label>
      </div>
    </div>
  )
}
