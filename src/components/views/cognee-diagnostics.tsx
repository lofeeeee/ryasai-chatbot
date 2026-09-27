'use client'

import { useState } from 'react'
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  Layers,
  Terminal,
  XCircle,
} from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import type { CogneeDiagnostics, EmbeddingDimensionInfo } from '@/lib/types'

/**
 * Per-component diagnosis of the memory sidecar.
 *
 * WHY THIS EXISTS. The card above it can only say "Connected" or "Disconnected", and that pair is
 * not enough to act on. MEASURED on a live install: cognee answered
 * `{"status":"ready","health":"healthy"}` while EVERY memory write failed — `LLM_API_KEY` was unset
 * and the graph-extension path was missing. An admin with a green badge had nothing to go on, and
 * the product stored nothing while claiming to work.
 *
 * `/health/detailed` names each dependency and carries the fix in `details`:
 *
 *   llm_provider   degraded  "LLMAPIKeyNotSetError: LLM API key is not set. … Set LLM_API_KEY"
 *
 * So this panel shows the component list, and for anything not healthy it shows that text verbatim
 * rather than a summary of it — the exact error is what makes it searchable and fixable.
 */

const STATUS_STYLE: Record<
  string,
  { icon: typeof CheckCircle2; className: string; label: string }
> = {
  healthy: { icon: CheckCircle2, className: 'text-success', label: 'Healthy' },
  degraded: { icon: AlertTriangle, className: 'text-warning', label: 'Degraded' },
  unhealthy: { icon: XCircle, className: 'text-destructive', label: 'Unhealthy' },
  unknown: { icon: CircleHelp, className: 'text-muted-foreground', label: 'Unknown' },
}

/** Friendly names. The API's snake_case keys are precise but not self-explanatory in a UI. */
const COMPONENT_LABEL: Record<string, string> = {
  relational_db: 'Relational store',
  vector_db: 'Vector store',
  graph_db: 'Knowledge graph',
  file_storage: 'File storage',
  llm_provider: 'Extraction LLM',
  embedding_service: 'Embedding service',
}

/**
 * Which fix to offer for a failing component.
 *
 * Driven by the component NAME rather than by pattern-matching the message text: prose changes
 * between releases, and a hint keyed to a substring would silently stop matching — the failure mode
 * this repo catalogs as "a branch on prose".
 *
 * There is deliberately no "you can ignore this" hint any more. One existed for
 * `embedding_service`, asserting it was a false alarm, and it was WRONG — see fixHintFor below. A UI
 * that tells an operator to disregard a real fault is worse than one that stays silent, so the
 * category is removed rather than kept available for the next hunch.
 */
function fixHintFor(name: string): { title: string; body: string } | null {
  if (name === 'llm_provider') {
    return {
      title: 'Memory needs its own LLM',
      body:
        'cognee runs its own extraction pipeline and cannot borrow the app\'s model — that config is ' +
        'encrypted in the database and unreadable from this container. Set the three LLM_ values in ' +
        '.env.cognee, then restart just this service.',
    }
  }
  if (name === 'embedding_service') {
    // This USED to say "may be a false alarm", on the evidence that a direct embedding call from the
    // same container succeeded. That reasoning was WRONG and is retracted here: a direct curl
    // bypasses litellm, which is exactly where the failure lives. `<provider>/<model>` is required,
    // and a bare model id makes litellm reject the request before it leaves the process — so the
    // endpoint looks healthy while cognee never calls it.
    return {
      title: 'Embedding model id is likely missing its provider prefix',
      body:
        'litellm reads the text before the slash as a PROVIDER name, so a bare model id is rejected ' +
        'with "LLM Provider NOT provided" and the request never reaches the endpoint. Check ' +
        'EMBEDDING_MODEL in .env.cognee — it must look like `openai/<model>`. A direct call to the ' +
        'endpoint succeeding does NOT prove this is fine: curl bypasses litellm entirely.',
    }
  }
  if (name === 'graph_db' || name === 'vector_db' || name === 'relational_db') {
    return {
      title: 'Storage component is not reachable',
      body:
        'These are internal to the sidecar container. A failure here usually means its volume is ' +
        'unwritable or the container was started without its storage paths.',
    }
  }
  return null
}

/**
 * Embedding width, with the two values side by side.
 *
 * WHY A COMPARISON AND NOT ONE NUMBER. A dimension alone cannot be wrong — only a disagreement
 * between the column and the model can. `DocumentChunk.embedding` was declared `vector(384)` while
 * the embedder is configured separately in AI Configuration, and when the two disagree pgvector
 * writes are SKIPPED and retrieval silently falls back to cosine-over-JSON. Correct but slower, and
 * with no user-visible symptom: the engine logs it once and then stays quiet.
 *
 * Also states that changing it is NOT a free setting, because it is not: the column type is part of
 * the storage, so a different width requires an ALTER plus re-embedding every document. An operator
 * who believes otherwise would change the model and lose vector search without noticing.
 */
export function EmbeddingDimensionRow({ info }: { info: EmbeddingDimensionInfo }) {
  if (info.columnDimension === null && info.modelDimension === null) return null
  const unknown = info.matches === null
  return (
    <div className="space-y-1 rounded-md border bg-muted/20 p-2.5">
      <div className="flex items-center gap-1.5">
        <Layers className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="text-[11px] font-medium">Embedding width</span>
        {unknown ? (
          <Badge variant="outline" className="text-[10px] text-muted-foreground">
            unknown
          </Badge>
        ) : info.matches ? (
          <Badge variant="outline" className="text-[10px]">
            <CheckCircle2 className="mr-1 h-2.5 w-2.5 text-success" />
            in sync
          </Badge>
        ) : (
          <Badge variant="destructive" className="text-[10px]">
            mismatch
          </Badge>
        )}
      </div>
      <div className="flex flex-wrap gap-x-3 font-mono text-[10px] text-muted-foreground">
        <span>column: {info.columnDimension ?? '—'}</span>
        <span>model: {info.modelDimension ?? '—'}</span>
      </div>
      {!unknown && !info.matches && (
        <p className="text-[10px] text-destructive">
          The model returns {info.modelDimension} dimensions but the column stores{' '}
          {info.columnDimension}, so pgvector writes are SKIPPED and search falls back to a slower
          path. Fix the model in AI Configuration, or resize the column and re-embed every document —
          this is not a free setting.
        </p>
      )}
      {unknown && (
        <p className="text-[10px] text-muted-foreground">
          Could not measure the model width (the embedding endpoint did not answer), so no comparison
          is claimed either way.
        </p>
      )}
    </div>
  )
}

export function CogneeDiagnosticsPanel({ diagnostics }: { diagnostics: CogneeDiagnostics }) {
  const [open, setOpen] = useState<string | null>(null)
  const [showSetup, setShowSetup] = useState(false)

  const problems = diagnostics.components.filter((c) => c.status !== 'healthy')

  return (
    <div className="space-y-2 rounded-md border bg-muted/20 p-2.5">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-[11px] font-medium">Diagnostics</span>
          <Badge
            variant={
              diagnostics.status === 'healthy'
                ? 'default'
                : diagnostics.status === 'degraded'
                  ? 'secondary'
                  : 'destructive'
            }
            className="text-[10px]"
          >
            {diagnostics.status}
          </Badge>
        </div>
        <Button
          size="sm"
          variant="ghost"
          className="h-6 px-2 text-[10px]"
          onClick={() => setShowSetup(!showSetup)}
        >
          <Terminal className="mr-1 h-3 w-3" />
          {showSetup ? 'Hide setup' : 'How to fix'}
        </Button>
      </div>

      {/*
        The summary is computed from the COMPONENT STATUSES, not from `diagnostics.status`.
        On a live sidecar the overall status read `degraded` while only the known-flaky embedding
        probe was unhappy — reporting "1 problem" there is honest; reporting it as a broad outage
        would not be.
      */}
      {problems.length === 0 ? (
        <p className="text-[10px] text-muted-foreground">
          Every dependency reports healthy. Memory can read and write.
        </p>
      ) : (
        <p className="text-[10px] text-muted-foreground">
          {problems.length} of {diagnostics.components.length} dependencies need attention
          {problems.some((p) => p.name === 'llm_provider')
            ? ' — and the extraction LLM is one of them, so memory writes will FAIL even though the container is up.'
            : '.'}
        </p>
      )}

      <div className="space-y-0.5">
        {diagnostics.components.map((c) => {
          const style = STATUS_STYLE[c.status] ?? STATUS_STYLE.unknown
          const Icon = style.icon
          const isOpen = open === c.name
          const hint = fixHintFor(c.name)
          const expandable = Boolean(c.details) && c.status !== 'healthy'
          return (
            <div key={c.name} className="rounded-sm">
              <button
                type="button"
                disabled={!expandable}
                onClick={() => setOpen(isOpen ? null : c.name)}
                className={`flex w-full items-center gap-1.5 rounded-sm px-1 py-1 text-left text-[11px] ${
                  expandable ? 'hover:bg-muted' : 'cursor-default'
                }`}
              >
                {expandable ? (
                  isOpen ? (
                    <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" />
                  ) : (
                    <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground" />
                  )
                ) : (
                  <span className="w-3 shrink-0" />
                )}
                <Icon className={`h-3 w-3 shrink-0 ${style.className}`} />
                <span className="flex-1 truncate">
                  {COMPONENT_LABEL[c.name] ?? c.name}
                </span>
                {c.provider && (
                  <span className="font-mono text-[10px] text-muted-foreground">{c.provider}</span>
                )}
                {c.responseTimeMs !== null && (
                  <span className="font-mono text-[10px] text-muted-foreground">
                    {c.responseTimeMs}ms
                  </span>
                )}
              </button>

              {isOpen && expandable && (
                <div className="ml-5 space-y-1.5 border-l pl-2 pb-1.5">
                  {/*
                    The sidecar's own text, verbatim and in a monospace block: it contains the exact
                    error name (`LLMAPIKeyNotSetError`) that makes the problem searchable, and
                    paraphrasing it would remove the only string an operator can look up.
                  */}
                  <pre className="whitespace-pre-wrap break-words font-mono text-[10px] text-muted-foreground">
                    {c.details}
                  </pre>
                  {hint && (
                    <div className="rounded-sm border border-warning/30 bg-warning/5 p-1.5">
                      <div className="text-[10px] font-medium">{hint.title}</div>
                      <p className="text-[10px] text-muted-foreground">{hint.body}</p>
                    </div>
                  )}
                </div>
              )}
            </div>
          )
        })}
      </div>

      {showSetup && (
        <div className="space-y-1.5 rounded-sm border bg-background p-2">
          <div className="text-[10px] font-medium">Configure memory</div>
          <p className="text-[10px] text-muted-foreground">
            Memory is configured in a file <strong>separate from the app&apos;s .env</strong>, so its
            credentials can be rotated without touching the license key or{' '}
            <code className="font-mono">ENCRYPTION_SECRET_KEY</code>.
          </p>
          <pre className="overflow-x-auto rounded-sm bg-muted p-2 font-mono text-[10px] leading-relaxed">{`# /opt/ryasai-chatbot/.env.cognee
LLM_PROVIDER=openai
LLM_ENDPOINT=https://your-gateway/v1
LLM_MODEL=openai/<your-model>     # provider prefix REQUIRED
LLM_API_KEY=<your-key>

# apply, then re-check this panel
docker compose -f /opt/ryasai-chatbot/docker-compose.prod.yml \\
  up -d cognee`}</pre>
          <p className="text-[10px] text-muted-foreground">
            The <code className="font-mono">openai/</code> prefix on the model is not decoration:
            litellm reads the part before the slash as a provider name, so a bare model id is treated
            as an unknown provider and the endpoint is never called.
          </p>
        </div>
      )}
    </div>
  )
}
