'use client'

import { useCallback, useEffect, useState } from 'react'
import {
  AlertTriangle,
  Brain,
  Check,
  CheckCircle2,
  CircleHelp,
  Copy,
  Database,
  Eye,
  EyeOff,
  Info,
  Loader2,
  RefreshCw,
  Save,
  Share2,
  Sparkles,
  Terminal,
  Trash2,
} from 'lucide-react'
import { toast } from 'sonner'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { DEFAULT_EMBEDDING_MODEL } from '@/lib/constants'
import { extractError } from '@/lib/extract-error'
import { cn } from '@/lib/utils'

/**
 * AI Memory Configuration — the memory sidecar's own extraction provider, and where its memory lives.
 *
 * TWO HALVES, ONE SCREEN, because they are the two questions an operator actually has about memory:
 * "what model extracts for me?" and "where is what it extracted?". Splitting them across tabs is how
 * the answer to the second became unanswerable — the storage facts existed in three components and
 * none of them said "this is your memory storage".
 *
 * STATE BEFORE FORM. The single most important fact here is not a field, it is which of two states the
 * install is in, and the two look nothing alike on the page: a dedicated model gets a filled badge and
 * the credentials it actually runs with, while "follows chat" gets a neutral block and NO fields at all.
 *
 * THE PROVIDER IS OPTIONAL, AND THAT IS THE DESIGN. Memory works today on every install that has
 * never opened this screen, because an unset memory provider FOLLOWS the chat provider. So the
 * default state is stated in words ("following Chat Configuration") rather than rendered as an empty
 * form waiting to be filled in — an empty form reads as "not configured", which would be wrong and
 * would send an operator to fix something that already works. The fields are one click away, behind a
 * control whose label says what it does.
 *
 * THE ENDPOINT GAP IS REPORTED, NOT HIDDEN. cognee's settings API accepts provider, model and API key
 * only — measured: posting `endpoint`, `api_base`, `baseUrl` and `apiEndpoint` all stored `''`. So a
 * base URL saved here is recorded in the app's own row but CANNOT reach the sidecar through the API;
 * the panel hands over the exact `.env.cognee` line as a copyable step instead of reporting a success
 * the sidecar cannot honour. This mirrors `cognee-config-push.ts`, which is where the measurement lives.
 *
 * UNKNOWN IS NOT HEALTHY. The storage grid always lists the four stores memory can live in, including
 * the ones the sidecar did not name, and a store it did not name shows "not reported" — never a green
 * tick over something nothing measured.
 */

interface MemoryProviderState {
  memory: { provider: string; baseUrl: string; model: string; apiKeyMasked: string | null } | null
  source: 'memory' | 'chat'
}

/** The sidecar's own report of where it stores things. Read, never inferred by this component. */
interface StorageFact {
  name: string
  status: string
  provider: string | null
}

/**
 * The stores that ARE memory storage, in the order the reading eye should take them.
 *
 * A fixed list rather than "whatever the sidecar sent", for two reasons: a store the sidecar did not
 * name must still be visible (as unknown), and the row order must not change between reloads — a
 * changing order is unreadable on a screen whose whole job is to be scannable. Anything in the
 * diagnostics payload that is not storage (the extraction model, the embedding service) is deliberately
 * absent: those belong to the card above, and listing them here would answer "where does memory live?"
 * with components that do not store anything.
 */
const MEMORY_STORES = [
  { name: 'relational_db', label: 'Relational store' },
  { name: 'vector_db', label: 'Vector store' },
  { name: 'graph_db', label: 'Knowledge graph' },
  { name: 'file_storage', label: 'File storage' },
] as const

const PROVIDER_LABEL: Record<string, string> = {
  OPENAI_COMPATIBLE: 'OpenAI compatible',
  ANTHROPIC_COMPATIBLE: 'Anthropic compatible',
}

/** What the panel knows about the sidecar's reachability, as four values rather than a boolean. */
export type SidecarState = 'reachable' | 'unreachable' | 'off' | 'unknown'

/**
 * Whether the sidecar answered, and whether memory is in use at all.
 *
 * READ FROM `enabled`/`connected`, DELIBERATELY NOT FROM `mode`. `cogneeHealth()` sets
 * `mode: 'disabled'` in TWO cases that mean opposite things to an operator — no sidecar URL
 * configured at all, and a URL configured that did not answer — so a badge keyed on it would report
 * "switch it back on" for a sidecar that is simply down, and vice versa. `enabled` is the switch and
 * `connected` is reachability; `mode` cannot separate them (this repo catalogues the shape: one value
 * carrying two meanings).
 *
 * The payload is also read for what it PROVES rather than for what it omits: `/api/cognee` can answer
 * `ok: true` on an install whose sidecar is switched off, and `diagnostics` is null both when memory
 * is off and when the sidecar cannot be reached. A non-empty component list can only exist because
 * `/health/detailed` answered, so it wins over a missing `connected` flag.
 */
export function readSidecarState(data: {
  enabled?: boolean
  connected?: boolean
  diagnostics?: { components?: unknown } | null
  /**
   * Present on the real payload, ACCEPTED AND DELIBERATELY NOT READ.
   *
   * Declared so this function can be handed the exact body `/api/cognee` returns — which does carry
   * `mode` — and so a test can pin that changing it alone never moves the verdict. Omitting it from the
   * type would push the tests to invent a payload shape the server does not send, and the field that
   * caused the original misreading would be the one nobody exercised.
   */
  mode?: string
} | null | undefined): SidecarState {
  const components = data?.diagnostics?.components
  if (Array.isArray(components) && components.length > 0) return 'reachable'
  if (data?.enabled === false) return 'off'
  if (data?.connected === true) return 'reachable'
  if (data?.connected === false) return 'unreachable'
  return 'unknown'
}

/**
 * The local, environment-side line as a STEP rather than a sentence.
 *
 * The operator's action is literally a paste into a file on the host, so the useful thing this panel
 * can do is hand over a line that does not have to be retyped — the failure mode of a mistyped base URL
 * is a sidecar that calls the wrong host and reports it as a provider error.
 *
 * The clipboard API is absent outside a secure context, which is a real deployment shape here
 * (installs reached over plain HTTP on a LAN). A blocked copy says so instead of showing a tick for a
 * copy that did not happen.
 */
function CopyLine({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 2000)
    } catch {
      toast.error('Could not copy the line', {
        description: 'The browser blocked clipboard access — select the line and copy it by hand.',
      })
    }
  }

  return (
    <Button
      size="sm"
      variant="outline"
      className="h-7 shrink-0 px-2 text-[10px]"
      onClick={() => void copy()}
    >
      {copied ? <Check className="h-3 w-3 text-success" /> : <Copy className="h-3 w-3" />}
      {copied ? 'Copied' : 'Copy'}
    </Button>
  )
}

/** The `.env.cognee` line, rendered as one unit: why it is needed, the line, and the control to take it. */
function EndpointStep({ value, warning }: { value: string; warning?: string }) {
  const text = `OPENAI_API_BASE=${value}`
  return (
    <div
      className={cn(
        'rounded-md border p-2.5 text-[11px] leading-snug',
        warning
          ? 'border-amber-600/40 bg-amber-500/10 text-amber-700 dark:text-amber-500'
          : 'border-border/70 bg-muted/20 text-muted-foreground',
      )}
    >
      <div className="flex items-start gap-1.5">
        <Terminal className="mt-0.5 h-3 w-3 shrink-0" />
        <span>
          {warning ?? (
            <>
              The sidecar reads its endpoint from <code className="font-mono">.env.cognee</code> — its settings
              API carries provider, model and key only, so a URL saved here cannot reach it.
            </>
          )}
        </span>
      </div>
      <div className="mt-1.5 flex items-center gap-1.5">
        <code className="min-w-0 flex-1 truncate rounded-sm border border-border/60 bg-background px-2 py-1 font-mono text-[11px] text-foreground">
          {text}
        </code>
        <CopyLine text={text} />
      </div>
      {!warning && <p className="mt-1.5">Add it, then restart the sidecar.</p>}
    </div>
  )
}

export function MemoryConfigurationPanel() {
  const [loading, setLoading] = useState(true)
  const [loadingStorage, setLoadingStorage] = useState(true)
  const [saving, setSaving] = useState(false)
  const [clearing, setClearing] = useState(false)
  const [state, setState] = useState<MemoryProviderState | null>(null)
  const [pushWarning, setPushWarning] = useState<{ endpointValue?: string; error?: string } | null>(null)
  const [storage, setStorage] = useState<StorageFact[] | null>(null)
  const [sidecar, setSidecar] = useState<SidecarState>('unknown')
  /**
   * Whether the operator asked to give memory a dedicated model.
   *
   * The fields exist in both states but are shown in only one by default, so the follow-chat screen
   * cannot be mistaken for an empty configuration waiting to be completed. A dedicated row is the
   * opposite case: there is something to edit, so the form is simply there.
   */
  const [dedicatedIntent, setDedicatedIntent] = useState(false)
  const [showKey, setShowKey] = useState(false)

  // Form fields, seeded from the saved row.
  const [provider, setProvider] = useState('OPENAI_COMPATIBLE')
  const [baseUrl, setBaseUrl] = useState('')
  const [model, setModel] = useState('')
  const [apiKey, setApiKey] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    setLoadingStorage(true)

    // Decoupled loading: Load memory LLM config fast so the model card renders immediately
    const cfgPromise = fetch('/api/llm-config/memory', { cache: 'no-store' })
      .then(async (cfgRes) => {
        const cfg = await cfgRes.json()
        if (cfg?.ok) {
          setState(cfg.data)
          setProvider(cfg.data?.memory?.provider ?? 'OPENAI_COMPATIBLE')
          setBaseUrl(cfg.data?.memory?.baseUrl ?? '')
          setModel(cfg.data?.memory?.model ?? '')
          setApiKey('')
        } else {
          setState(null)
        }
      })
      .catch(() => {
        setState(null)
      })
      .finally(() => {
        setLoading(false)
      })

    // Load storage facts independently so sidecar health & embed tests don't delay the model form
    const cogneePromise = fetch('/api/cognee', { cache: 'no-store' })
      .then(async (cogRes) => {
        const cog = await cogRes.json()
        if (cog?.ok) {
          const components = cog.data?.diagnostics?.components
          setStorage(Array.isArray(components) ? components : null)
          setSidecar(readSidecarState(cog.data))
        }
      })
      .catch(() => {
        // storage facts unavailable
      })
      .finally(() => {
        setLoadingStorage(false)
      })

    await Promise.allSettled([cfgPromise, cogneePromise])
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const save = async () => {
    setSaving(true)
    try {
      const res = await fetch('/api/llm-config/memory', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider, baseUrl, model, apiKey }),
      })
      const json = await res.json()
      if (!res.ok || !json.ok) {
        toast.error('Could not save the memory provider', {
          description: extractError(json?.error ?? json, 'The request was refused.'),
        })
        return
      }
      setState(json.data)
      setApiKey('')
      setPushWarning(null)
      const push = json.data?.push
      if (push?.endpointNeedsEnv) {
        // A real gap, reported as one. Not an error: provider, model and key DID land.
        setPushWarning({ endpointValue: push.endpointValue, error: push.error })
        toast.warning('Memory provider saved — one manual step left', {
          duration: 20000,
          description: push.error ?? `Set OPENAI_API_BASE=${push.endpointValue} in .env.cognee`,
        })
      } else if (push && !push.ok) {
        toast.warning('Saved, but the sidecar did not take it', {
          duration: 15000,
          description: push.error ?? push.detail,
        })
      } else {
        toast.success('Memory provider saved', { description: push?.detail })
      }
    } catch (e) {
      toast.error('Could not save the memory provider', {
        description: e instanceof Error ? e.message : undefined,
      })
    } finally {
      setSaving(false)
    }
  }

  const clear = async () => {
    setClearing(true)
    try {
      const res = await fetch('/api/llm-config/memory', { method: 'DELETE' })
      const json = await res.json()
      if (!res.ok || !json.ok) {
        toast.error('Could not clear the memory provider', {
          description: extractError(json?.error ?? json, 'The request was refused.'),
        })
        return
      }
      setState(json.data)
      setBaseUrl('')
      setModel('')
      setApiKey('')
      setPushWarning(null)
      setDedicatedIntent(false)
      toast.success('Memory now follows Chat Configuration', { description: json.data?.push?.detail })
    } catch (e) {
      toast.error('Could not clear the memory provider', {
        description: e instanceof Error ? e.message : undefined,
      })
    } finally {
      setClearing(false)
    }
  }

  /** Collapse the opt-in form and drop anything typed, so a later reveal starts from the stored state. */
  const cancelDedicated = () => {
    setDedicatedIntent(false)
    setProvider(state?.memory?.provider ?? 'OPENAI_COMPATIBLE')
    setBaseUrl(state?.memory?.baseUrl ?? '')
    setModel(state?.memory?.model ?? '')
    setApiKey('')
  }

  const usingOwn = state?.source === 'memory'
  const showForm = usingOwn || dedicatedIntent

  const facts = new Map((storage ?? []).map((c) => [c.name, c]))
  const missingStores = MEMORY_STORES.filter((s) => !facts.has(s.name)).length

  /*
   * ONE definition of the reload control, rendered by BOTH the failure banner and the standing footer.
   * The banner's own text tells the operator to reload before saving; leaving them without the control
   * that does it turns the only safe action on a failed read into a manual page refresh.
   */
  const reloadButton = (
    <Button
      size="sm"
      variant="ghost"
      className="h-7 shrink-0 text-xs"
      onClick={() => void load()}
      disabled={loading || saving || clearing}
    >
      <RefreshCw className="h-3 w-3" />
      Reload
    </Button>
  )

  const sidecarBadge: { label: string; variant: 'success' | 'warning' | 'outline'; Icon: typeof CheckCircle2 } =
    sidecar === 'reachable'
      ? { label: 'Reachable', variant: 'success', Icon: CheckCircle2 }
      : sidecar === 'unreachable'
        ? { label: 'Unreachable', variant: 'warning', Icon: AlertTriangle }
        : sidecar === 'off'
          ? { label: 'Memory off', variant: 'outline', Icon: Info }
          : { label: 'Status unknown', variant: 'outline', Icon: CircleHelp }

  /*
   * The warning text is the server's OWN sentence, which names the host the sidecar will call instead.
   * It is longer than the neutral line on purpose: it appears right after an action that succeeded only
   * in part, and the operator has to be able to tell which half.
   */
  const endpointWarning = pushWarning?.endpointValue
    ? (pushWarning.error ??
      'The endpoint cannot be shared through the sidecar settings API, so it will keep calling api.openai.com until you set this line in .env.cognee.')
    : undefined

  return (
    <div className="space-y-3">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-sm">
            <Brain className="h-4 w-4 text-primary" />
            Memory Extraction Model
          </CardTitle>
          <CardDescription className="text-xs">
            The model the memory sidecar extracts entities and relationships with. It runs its own pipeline
            against your provider, and extraction is high-volume and structure-bound — where a fast model is
            usually the better trade than the one that answers chat.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {loading ? (
            <div className="flex items-center gap-2 py-4 text-xs text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Loading memory configuration…
            </div>
          ) : state === null ? (
            <div className="flex flex-wrap items-start justify-between gap-3 rounded-md border border-destructive/40 bg-destructive/10 p-2.5 text-xs text-destructive">
              <div className="flex min-w-0 items-start gap-2">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <div>
                  Could not load the memory configuration. This is a failed read, not an empty one — reload
                  before saving, or you would overwrite the stored provider with these blank fields.
                </div>
              </div>
              {reloadButton}
            </div>
          ) : (
            <>
              {/*
                THE STATE, FIRST AND LARGE. The two branches are deliberately different shapes rather
                than one box with two labels: "has a dedicated model" is an owner with credentials to
                audit, "follows chat" has no credentials of its own to show at all.
              */}
              {usingOwn ? (
                <div className="flex flex-wrap items-start justify-between gap-3 rounded-md border border-primary/30 bg-primary/5 p-2.5">
                  <div className="min-w-0 space-y-1.5">
                    <Badge variant="default" className="px-2.5 py-0.5 text-[11px]">
                      own model
                    </Badge>
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 font-mono text-[11px] text-muted-foreground">
                      <span className="truncate">{state.memory?.model || '—'}</span>
                      <span aria-hidden="true">·</span>
                      <span className="truncate">{state.memory?.baseUrl || '—'}</span>
                      {state.memory?.apiKeyMasked && (
                        <>
                          <span aria-hidden="true">·</span>
                          <span className="truncate">{state.memory.apiKeyMasked}</span>
                        </>
                      )}
                    </div>
                    <p className="text-[11px] leading-snug text-muted-foreground">
                      {state.memory
                        ? (PROVIDER_LABEL[state.memory.provider] ?? state.memory.provider)
                        : 'Unknown provider'}{' '}
                      — memory extracts with these credentials rather than with the chat model.
                    </p>
                  </div>
                </div>
              ) : (
                <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border/70 bg-muted/20 p-2.5">
                  <div className="min-w-0 space-y-1.5">
                    <Badge variant="outline" className="px-2.5 py-0.5 text-[11px]">
                      <Share2 className="h-2.5 w-2.5" />
                      following Chat Configuration
                    </Badge>
                    <p className="text-[11px] leading-snug text-muted-foreground">
                      No dedicated model is stored, so memory extracts with whatever answers chat. That is a
                      working setup — there is nothing to fill in here.
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    {!dedicatedIntent && (
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 shrink-0 text-xs"
                        onClick={() => setDedicatedIntent(true)}
                      >
                        <Sparkles className="h-3 w-3" />
                        Use a dedicated model
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 shrink-0 text-xs"
                      onClick={() => void load()}
                      disabled={loading}
                    >
                      <RefreshCw className="h-3 w-3" />
                      Reload
                    </Button>
                  </div>
                </div>
              )}

              {showForm && (
                <div className="space-y-3">
                  {/*
                    One column until `sm`, so a 390px phone gets full-width controls rather than a
                    squeezed provider select beside a truncated model id. `min-w-0` is what lets the
                    truncating monospace values shrink instead of forcing the row wider than the card.
                  */}
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div className="min-w-0 space-y-1.5">
                      <Label htmlFor="mem-provider" className="text-xs">
                        Provider
                      </Label>
                      <Select value={provider} onValueChange={setProvider}>
                        <SelectTrigger id="mem-provider" className="w-full text-xs">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="OPENAI_COMPATIBLE">OpenAI compatible</SelectItem>
                          <SelectItem value="ANTHROPIC_COMPATIBLE">Anthropic compatible</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="min-w-0 space-y-1.5">
                      <Label htmlFor="mem-model" className="text-xs">
                        Model
                      </Label>
                      <Input
                        id="mem-model"
                        value={model}
                        onChange={(e) => setModel(e.target.value)}
                        placeholder="e.g. cbcn/deepseek-v4-flash"
                        className="font-mono text-xs"
                      />
                    </div>
                  </div>

                  <div className="min-w-0 space-y-1.5">
                    <Label htmlFor="mem-base" className="text-xs">
                      Base URL
                    </Label>
                    <Input
                      id="mem-base"
                      value={baseUrl}
                      onChange={(e) => setBaseUrl(e.target.value)}
                      placeholder="https://your-gateway.example/v1"
                      className="font-mono text-xs"
                    />
                    {(pushWarning?.endpointValue || baseUrl) && (
                      <EndpointStep
                        value={pushWarning?.endpointValue ?? baseUrl}
                        warning={endpointWarning}
                      />
                    )}
                  </div>

                  <div className="min-w-0 space-y-1.5">
                    <Label htmlFor="mem-key" className="text-xs">
                      API Key
                    </Label>
                    <div className="relative">
                      <Input
                        id="mem-key"
                        type="text"
                        value={apiKey}
                        onChange={(e) => setApiKey(e.target.value)}
                        placeholder={
                          state.memory?.apiKeyMasked
                            ? `${state.memory.apiKeyMasked} — blank keeps this`
                            : 'Required on first save'
                        }
                        className={cn('pr-10 font-mono text-xs', !showKey && 'text-security-disc')}
                        autoComplete="new-password"
                        spellCheck={false}
                      />
                      <button
                        type="button"
                        onClick={() => setShowKey((v) => !v)}
                        className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                        aria-label={showKey ? 'Hide API key' : 'Show API key'}
                      >
                        {showKey ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                      </button>
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center gap-2 pt-1">
                    <Button size="sm" onClick={() => void save()} disabled={saving}>
                      {saving ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Save className="h-3.5 w-3.5" />
                      )}
                      Save and share with memory
                    </Button>
                    {usingOwn && (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => void clear()}
                        disabled={clearing || saving}
                      >
                        {clearing ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <Trash2 className="h-3.5 w-3.5" />
                        )}
                        Clear, follow chat
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => void load()}
                      disabled={loading || saving || clearing}
                    >
                      <RefreshCw className="h-3.5 w-3.5" />
                      Reload
                    </Button>
                    {!usingOwn && (
                      <Button size="sm" variant="ghost" onClick={cancelDedicated}>
                        Cancel
                      </Button>
                    )}
                  </div>
                </div>
              )}

              {/*
                A STANDING FOOTER, not a note under the form: whether the push happens is true before and
                after any edit, and it is the fact that explains why a working configuration can still fail
                after the sidecar restarts. The reload control lives here so it is reachable in every
                state, including the failed read where the form is gone.
              */}
              <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5 border-t border-border/60 pt-2.5">
                <p className="min-w-0 flex-1 text-[11px] leading-snug text-muted-foreground">
                  Saving pushes the credentials to the sidecar immediately. It keeps them in memory only, so
                  the app re-shares them at every start — expected, not a failure.
                </p>
                {reloadButton}
              </div>
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex flex-wrap items-center gap-2 text-sm">
            <Database className="h-4 w-4 text-primary" />
            Memory Storage
            {/*
              The sidecar's REACHABILITY, stated rather than implied by the grid below: four rows that
              each say "not reported" are honest but give no hint whether that is a switched-off install
              or a sidecar that stopped answering.
            */}
            <Badge variant={sidecarBadge.variant} className="gap-1 text-[10px]">
              <sidecarBadge.Icon className="h-2.5 w-2.5" />
              {sidecarBadge.label}
            </Badge>
            {loadingStorage && (
              <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />
            )}
          </CardTitle>
          <CardDescription className="text-xs">
            Where memory actually lives. These are measured facts from the sidecar's own report, not
            settings — the storage backends are fixed by the deployment, so there is nothing to change here.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          {/*
            ALWAYS FOUR ROWS. A store the sidecar did not name keeps its label and says "not reported",
            which is a state an operator can read at a glance; collapsing the block into a sentence made
            "nothing was measured" indistinguishable from "this screen has nothing to show".
          */}
          <div className="grid gap-2 grid-cols-2 lg:grid-cols-4">
            {MEMORY_STORES.map(({ name, label }) => {
              const fact = facts.get(name)
              return (
                <div
                  key={name}
                  className={cn(
                    'flex items-center justify-between gap-2 rounded-md border px-2.5 py-2 transition-colors',
                    fact ? 'border-border/70 bg-muted/20' : 'border-dashed border-border/70 bg-muted/5',
                  )}
                >
                  <span className="min-w-0 truncate text-xs font-medium">{label}</span>
                  {fact ? (
                    <span className="flex shrink-0 items-center gap-1.5">
                      <span className="max-w-[6rem] truncate font-mono text-[11px] text-muted-foreground">
                        {fact.provider || '—'}
                      </span>
                      {fact.status === 'healthy' ? (
                        <CheckCircle2 className="h-3 w-3 text-success" />
                      ) : (
                        <>
                          <span className="text-[10px] text-amber-600">{fact.status}</span>
                          <AlertTriangle className="h-3 w-3 text-amber-500" />
                        </>
                      )}
                    </span>
                  ) : (
                    <span className="flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground">
                      <CircleHelp className="h-3 w-3" />
                      not reported
                    </span>
                  )}
                </div>
              )
            })}
          </div>

          {missingStores > 0 && (
            <p className="text-[11px] leading-snug text-muted-foreground">
              {missingStores < MEMORY_STORES.length
                ? `${missingStores} of ${MEMORY_STORES.length} stores were absent from the sidecar's report, so they are unknown rather than empty — the sidecar did not name them as a fault either.`
                : sidecar === 'off'
                  ? 'Memory is switched off, so the sidecar reports no storage backends.'
                  : 'The sidecar is not reporting its storage backends, so this is unknown rather than empty. A green status here would be a claim nothing measured.'}
            </p>
          )}

          <div className="flex items-start gap-2 rounded-md border border-border/70 bg-muted/20 p-2.5 text-[11px] text-muted-foreground">
            <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <div>
              Memory keeps its knowledge graph on an embedded store inside the deployment and its vectors
              beside the app&apos;s own PostgreSQL. Its embedding model is{' '}
              <code className="font-mono">{DEFAULT_EMBEDDING_MODEL}</code> — the same embedder RAG uses, which
              is what makes one model serve both. It is set by the deployment, so the Embedding tab shows it as
              a fact rather than offering a field that could not take effect.
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
