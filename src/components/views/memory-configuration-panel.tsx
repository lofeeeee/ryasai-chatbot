'use client'

import { useCallback, useEffect, useState } from 'react'
import { AlertTriangle, Brain, CheckCircle2, Database, Info, Loader2, RefreshCw, Save, Share2, Trash2 } from 'lucide-react'
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

/**
 * AI Memory Configuration — the memory sidecar's own extraction provider, and where its memory lives.
 *
 * TWO HALVES, ONE SCREEN, because they are the two questions an operator actually has about memory:
 * "what model extracts for me?" and "where is what it extracted?". Splitting them across tabs is how
 * the answer to the second became unanswerable — the storage facts existed in three components and
 * none of them said "this is your memory storage".
 *
 * THE PROVIDER IS OPTIONAL, AND THAT IS THE DESIGN. Memory works today on every install that has
 * never opened this screen, because an unset memory provider FOLLOWS the chat provider. So the
 * default state is stated in words ("following Chat Configuration") rather than rendered as an empty
 * form waiting to be filled in — an empty form reads as "not configured", which would be wrong and
 * would send an operator to fix something that already works.
 *
 * THE ENDPOINT GAP IS REPORTED, NOT HIDDEN. cognee's settings API accepts provider, model and API key
 * only — measured: posting `endpoint`, `api_base`, `baseUrl` and `apiEndpoint` all stored `''`. So a
 * base URL saved here is recorded in the app's own row but CANNOT reach the sidecar through the API;
 * the panel says so with the exact `.env.cognee` line instead of reporting a success the sidecar
 * cannot honour. This mirrors `cognee-config-push.ts`, which is where the measurement lives.
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

const STORAGE_LABELS: Record<string, string> = {
  relational_db: 'Relational store',
  vector_db: 'Vector store',
  graph_db: 'Knowledge graph',
  file_storage: 'File storage',
}

export function MemoryConfigurationPanel() {
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [clearing, setClearing] = useState(false)
  const [state, setState] = useState<MemoryProviderState | null>(null)
  const [pushWarning, setPushWarning] = useState<{ endpointValue?: string; error?: string } | null>(null)
  const [storage, setStorage] = useState<StorageFact[] | null>(null)
  const [pendingEndpoint, setPendingEndpoint] = useState<string | null>(null)

  // Form fields, seeded from the saved row.
  const [provider, setProvider] = useState('OPENAI_COMPATIBLE')
  const [baseUrl, setBaseUrl] = useState('')
  const [model, setModel] = useState('')
  const [apiKey, setApiKey] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [cfgRes, cogneeRes] = await Promise.all([
        fetch('/api/llm-config/memory', { cache: 'no-store' }),
        // The storage facts come from the SAME endpoint the memory card uses: the sidecar's own
        // `/health/detailed`, surfaced by this route. Deliberately not a new probe — a second reader
        // of the same fact is how two screens end up disagreeing about where memory lives.
        fetch('/api/cognee', { cache: 'no-store' }),
      ])
      const cfg = await cfgRes.json()
      if (cfg?.ok) {
        setState(cfg.data)
        setProvider(cfg.data?.memory?.provider ?? 'OPENAI_COMPATIBLE')
        setBaseUrl(cfg.data?.memory?.baseUrl ?? '')
        setModel(cfg.data?.memory?.model ?? '')
        setApiKey('')
      }
      const cog = await cogneeRes.json()
      if (cog?.ok) {
        const components = cog.data?.diagnostics?.components
        setStorage(Array.isArray(components) ? components : null)
        // Prefill the endpoint remedy from the app's configured chat endpoint, so the copy is
        // actionable even before a push has been attempted.
        setPendingEndpoint(cog.data?.llmEndpoint ?? null)
      }
    } catch {
      // A failed load must not paint an empty form: the section below renders "unknown".
      setState(null)
    } finally {
      setLoading(false)
    }
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
      toast.success('Memory now follows Chat Configuration', { description: json.data?.push?.detail })
    } catch (e) {
      toast.error('Could not clear the memory provider', {
        description: e instanceof Error ? e.message : undefined,
      })
    } finally {
      setClearing(false)
    }
  }

  const usingOwn = state?.source === 'memory'
  const storageRows = (storage ?? []).filter((c) => STORAGE_LABELS[c.name])

  return (
    <div className="space-y-3">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-sm">
            <Brain className="h-4 w-4 text-primary" />
            Memory Extraction Model
            {usingOwn ? (
              <Badge variant="default" className="text-[10px]">
                own model
              </Badge>
            ) : (
              <Badge variant="outline" className="text-[10px] text-muted-foreground">
                following Chat Configuration
              </Badge>
            )}
          </CardTitle>
          <CardDescription className="text-xs">
            The model the memory sidecar uses to extract entities and relationships from conversations. It
            runs its own pipeline against your provider, so it can use a different model than the one that
            answers chat — extraction is high-volume and structure-bound, where a fast model is usually the
            better trade. <strong>Leave this unset and memory follows your chat provider.</strong>
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {loading ? (
            <div className="flex items-center gap-2 py-4 text-xs text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Loading memory configuration…
            </div>
          ) : state === null ? (
            <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-2.5 text-xs text-destructive">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <div>
                Could not load the memory configuration. This is a failed read, not an empty one — reload
                before saving, or you would overwrite the stored provider with these blank fields.
              </div>
            </div>
          ) : (
            <>
              <div className="grid gap-3 md:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="mem-provider">Provider</Label>
                  <Select value={provider} onValueChange={setProvider}>
                    <SelectTrigger id="mem-provider" className="text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="OPENAI_COMPATIBLE">OpenAI compatible</SelectItem>
                      <SelectItem value="ANTHROPIC_COMPATIBLE">Anthropic compatible</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="mem-model">Model</Label>
                  <Input
                    id="mem-model"
                    value={model}
                    onChange={(e) => setModel(e.target.value)}
                    placeholder="e.g. cbcn/deepseek-v4-flash"
                    className="font-mono text-xs"
                  />
                </div>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="mem-base">Base URL</Label>
                <Input
                  id="mem-base"
                  value={baseUrl}
                  onChange={(e) => setBaseUrl(e.target.value)}
                  placeholder="https://your-gateway.example/v1"
                  className="font-mono text-xs"
                />
                <p className="text-[11px] leading-snug text-muted-foreground">
                  Recorded here so the app knows where this provider lives. The sidecar cannot receive it
                  through its settings API, so if it differs from your chat endpoint it must also be set as{' '}
                  <code className="font-mono">OPENAI_API_BASE</code> in <code className="font-mono">.env.cognee</code>.
                </p>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="mem-key">API Key</Label>
                <Input
                  id="mem-key"
                  type="password"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder={
                    state.memory?.apiKeyMasked ? `${state.memory.apiKeyMasked} — blank keeps this` : 'Required on first save'
                  }
                  className="font-mono text-xs"
                />
              </div>

              {pushWarning?.endpointValue && (
                <div className="flex items-start gap-2 rounded-md border border-amber-600/40 bg-amber-500/10 p-2.5 text-[11px] text-amber-700 dark:text-amber-500">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <div>
                    {pushWarning.error ?? 'The sidecar cannot receive the endpoint through its API.'}
                    <div className="mt-1 font-mono">
                      OPENAI_API_BASE={pushWarning.endpointValue}
                    </div>
                  </div>
                </div>
              )}

              <div className="flex flex-wrap items-center gap-2">
                <Button size="sm" onClick={() => void save()} disabled={saving}>
                  {saving ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Save className="mr-1.5 h-3.5 w-3.5" />}
                  Save and share with memory
                </Button>
                {usingOwn && (
                  <Button size="sm" variant="outline" onClick={() => void clear()} disabled={clearing}>
                    {clearing ? (
                      <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Trash2 className="mr-1.5 h-3.5 w-3.5" />
                    )}
                    Clear, follow chat
                  </Button>
                )}
                <Button size="sm" variant="ghost" onClick={() => void load()} disabled={loading}>
                  <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
                  Reload
                </Button>
              </div>
              <p className="text-[11px] leading-snug text-muted-foreground">
                Saving pushes the credentials to the sidecar immediately. The sidecar keeps them in memory
                only, so the app re-shares them at every restart — that is expected, not a failure.
              </p>
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-sm">
            <Database className="h-4 w-4 text-primary" />
            Memory Storage
          </CardTitle>
          <CardDescription className="text-xs">
            Where memory actually lives, as reported by the sidecar itself. These are measured facts, not
            settings — the storage backends are fixed by the deployment, so there is nothing to change here.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          {storageRows.length > 0 ? (
            <div className="grid gap-1.5 sm:grid-cols-2">
              {storageRows.map((c) => (
                <div
                  key={c.name}
                  className="flex items-center justify-between rounded-md border border-border/70 bg-muted/20 px-2.5 py-1.5"
                >
                  <span className="text-xs">{STORAGE_LABELS[c.name]}</span>
                  <span className="flex items-center gap-1.5">
                    <span className="font-mono text-xs">{c.provider ?? 'unknown'}</span>
                    {c.status === 'healthy' ? (
                      <CheckCircle2 className="h-3 w-3 text-success" />
                    ) : (
                      <AlertTriangle className="h-3 w-3 text-amber-500" />
                    )}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">
              The sidecar is not reporting its storage backends, so this is unknown rather than empty. A
              green status here would be a claim nothing measured.
            </p>
          )}
          <div className="flex items-start gap-2 rounded-md border border-border/70 bg-muted/20 p-2.5 text-[11px] text-muted-foreground">
            <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <div>
              Memory keeps its knowledge graph on an embedded store inside the deployment and its vectors
              beside the app&apos;s own PostgreSQL. The memory embedding model is{' '}
              <code className="font-mono">{DEFAULT_EMBEDDING_MODEL}</code> — the same embedder RAG uses,
              which is what makes one model serve both. It is set by the deployment, so the Embedding tab
              shows it as a fact rather than offering a field that could not take effect.
            </div>
          </div>
          {pendingEndpoint === null && (
            <p className="text-[11px] text-muted-foreground">
              <Share2 className="mr-1 inline h-3 w-3" />
              Sharing happens automatically at every app start.
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
