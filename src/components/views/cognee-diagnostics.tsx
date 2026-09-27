'use client'

import { useState } from 'react'
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  Terminal,
  XCircle,
} from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import type { CogneeDiagnostics } from '@/lib/types'

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
 * Which fix to offer for a failing component, and whether it is worth the operator's time.
 *
 * Driven by the component NAME rather than by pattern-matching the message text: prose changes
 * between releases, and a hint keyed to a substring would silently stop matching — the failure mode
 * this repo catalogs as "a branch on prose".
 *
 * `ignoreLikely` marks a probe known to cry wolf. Those render INLINE rather than behind the
 * accordion: burying "you can probably ignore this" one click deep costs an operator the same time
 * as a real fault, which defeats the point of distinguishing them.
 */
function fixHintFor(name: string): { title: string; body: string; ignoreLikely?: boolean } | null {
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
    return {
      title: 'Often a FALSE ALARM — verify before acting',
      body:
        'This check calls the embedding endpoint with a 30s budget and can report "timed out" while ' +
        'real embedding calls succeed. Measured on a production sidecar: this component said ' +
        'degraded while the same container returned a valid 384-dimension vector. If documents are ' +
        'being embedded normally, this warning can be ignored.',
      ignoreLikely: true,
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

              {/*
                The "probably ignore this" hint renders WITHOUT a click. Hiding it behind the
                accordion makes a cry-wolf probe cost the same attention as a real fault, which is
                exactly what this panel exists to prevent.
              */}
              {hint?.ignoreLikely && !isOpen && (
                <p className="ml-5 pl-2 text-[10px] text-muted-foreground">
                  Likely a false alarm — click for details.
                </p>
              )}

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
