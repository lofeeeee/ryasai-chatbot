'use client'

import { useState } from 'react'
import { Database, HardDrive, CheckCircle2, Loader2, AlertCircle, ArrowRight, Brain } from 'lucide-react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { MemoryStatusCard } from '@/components/views/memory-status-card'
import { CogneeCard } from '@/components/views/cognee-card'
import { extractError } from '@/lib/extract-error'
import { getVectorStorePreset } from '@/lib/db-provider-presets'
import { cn } from '@/lib/utils'

/** What the view read from `GET /api/vector-store` — the shape this panel branches on. */
export interface StorageChoiceView {
  chosen: boolean
  provider: string
  baseUrl: string
  collectionName: string
}

/**
 * Knowledge → Storage: the ONE place that answers "where does this install keep things".
 *
 * WHY THIS EXISTS. The Knowledge menu used to be a document list with a single "Vector Store" tab, and the operator
 * had no way to tell what the knowledge base ran on. Measured in UAT: the same vector-store form appeared in the
 * memory settings too, so two menus edited one row and neither said which part of the system it governed — the
 * cognee memory backend and the knowledge uploader were configured as if they were one thing. They are not:
 *
 *   - **AI Memory** (cross-session memory + knowledge graph) is the bundled PostgreSQL of THIS install,
 *     always. It cannot point anywhere else, so it is not a control — it is a fact, shown as one. The one
 *     legitimate exception is the graph, which stays on cognee's embedded Kuzu store because the vendor labels
 *     its PostgreSQL graph adapter a non-production demo; that is stated rather than hidden.
 *   - **Knowledge storage** (where uploaded documents are embedded for retrieval) is a real choice: the bundled
 *     PostgreSQL/pgvector, or an external vector database. It is REQUIRED before documents can be uploaded, and
 *     this panel is where it is made.
 *
 * Picking Internal saves immediately (there is nothing else to fill in). Picking External hands over to the
 * External Vector DB tab, because an external store is not chosen until its connection details are valid — and
 * that save is what records the choice. The API refuses an external provider without a base URL (fail-closed), so
 * "chosen" can never mean "pointed at nothing".
 */
export function KnowledgeStoragePanel({
  choice,
  loading,
  loadError,
  onChanged,
  onConfigureExternal,
}: {
  choice: StorageChoiceView | null
  loading: boolean
  loadError: boolean
  onChanged: () => void | Promise<void>
  onConfigureExternal: () => void
}) {
  const [savingInternal, setSavingInternal] = useState(false)
  const [showMemoryDetail, setShowMemoryDetail] = useState(false)

  const provider = choice?.provider ?? 'INTERNAL'
  const backend = getVectorStorePreset(provider)?.backend ?? provider
  const isInternal = backend === 'INTERNAL'
  const providerLabel = getVectorStorePreset(provider)?.label ?? provider
  const chosen = choice?.chosen ?? false

  const useInternal = async () => {
    setSavingInternal(true)
    try {
      const res = await fetch('/api/vector-store', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: 'INTERNAL', baseUrl: '' }),
      })
      const json = await res.json()
      if (!res.ok || !json.ok) {
        throw new Error(extractError(json.error, 'Failed to save the storage choice.'))
      }
      toast.success('Knowledge storage set to the bundled PostgreSQL.', {
        description: 'Uploads are now enabled.',
      })
      await onChanged()
    } catch (e) {
      toast.error('Failed to save the storage choice', {
        description: e instanceof Error ? e.message : undefined,
      })
    } finally {
      setSavingInternal(false)
    }
  }

  return (
    <div className="space-y-3">
      {loadError && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 flex items-start gap-2">
          <AlertCircle className="h-4 w-4 text-destructive shrink-0 mt-0.5" />
          <div className="text-xs text-destructive">
            Could not read the current storage configuration, so the choice below may be out of date. Reload the
            page before changing it.
          </div>
        </div>
      )}

      {!chosen && !loading && !loadError && (
        <div className="rounded-md border border-warning/40 bg-warning/10 p-3 flex items-start gap-2">
          <AlertCircle className="h-4 w-4 text-warning shrink-0 mt-0.5" />
          <div className="text-xs">
            <span className="font-medium">No storage chosen yet — document uploads are blocked.</span>{' '}
            Pick where the knowledge base lives below. Nothing is embedded until you do.
          </div>
        </div>
      )}

      {/* ---------------------------------------------------------- AI Memory */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <div className="h-9 w-9 rounded-lg bg-primary/10 text-primary flex items-center justify-center">
                <Brain className="h-4.5 w-4.5" />
              </div>
              <div>
                <CardTitle className="text-xs">AI Memory</CardTitle>
                <p className="text-xs text-muted-foreground">
                  Bundled PostgreSQL of this install — not configurable, and not affected by the knowledge storage
                  choice below.
                </p>
              </div>
            </div>
            <Button
              size="sm"
              variant="outline"
              className="h-7 text-xs shrink-0"
              icon={<Brain className="h-3.5 w-3.5" />}
              onClick={() => setShowMemoryDetail((v) => !v)}
            >
              {showMemoryDetail ? 'Hide Details' : 'Details'}
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          <ul className="text-xs text-muted-foreground space-y-1">
            <li>
              <span className="text-foreground">Conversation memory</span> — stored in this install&apos;s own
              PostgreSQL. Memory never leaves the server, and there is no provider to configure.
            </li>
            <li>
              <span className="text-foreground">Knowledge graph</span> — runs on cognee&apos;s embedded Kuzu
              store. The vendor labels its PostgreSQL graph adapter a non-production demo, so the graph
              deliberately stays on the embedded engine while everything else moved to PostgreSQL.
            </li>
          </ul>
          <MemoryStatusCard />
          {showMemoryDetail && (
            <div className="pt-2 border-t border-border/70">
              <CogneeCard />
            </div>
          )}
        </CardContent>
      </Card>

      {/* --------------------------------------------- knowledge storage choice */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center gap-2">
            <div className="h-9 w-9 rounded-lg bg-primary/10 text-primary flex items-center justify-center">
              <HardDrive className="h-4.5 w-4.5" />
            </div>
            <div>
              <CardTitle className="text-xs">Knowledge storage</CardTitle>
              <p className="text-xs text-muted-foreground">
                Where uploaded documents are embedded for retrieval. Required before the first upload.
              </p>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="text-xs">
            {loading ? (
              <span className="text-muted-foreground inline-flex items-center gap-1.5">
                <Loader2 className="h-3 w-3 animate-spin" /> Checking the current choice…
              </span>
            ) : chosen ? (
              <span className="text-muted-foreground">
                Current:{' '}
                <span className="text-foreground font-medium">
                  {isInternal ? 'Bundled PostgreSQL (pgvector)' : providerLabel}
                </span>
                {!isInternal && choice?.baseUrl ? (
                  <>
                    {' — '}
                    <span className="font-mono">{choice.baseUrl}</span>, collection{' '}
                    <span className="font-mono">{choice.collectionName}</span>
                  </>
                ) : null}
              </span>
            ) : (
              <span className="text-muted-foreground">Nothing chosen yet.</span>
            )}
          </div>

          <div className="grid gap-2 md:grid-cols-2">
            <button
              type="button"
              onClick={useInternal}
              disabled={savingInternal || loadError || (chosen && isInternal)}
              className={cn(
                'text-left rounded-lg border p-3 transition-colors disabled:opacity-60',
                chosen && isInternal ? 'border-primary/60 bg-primary/5' : 'hover:border-primary/40',
              )}
            >
              <div className="flex items-center gap-2">
                <HardDrive className="h-4 w-4 shrink-0" />
                <span className="text-xs font-medium">Bundled PostgreSQL</span>
                {chosen && isInternal && <CheckCircle2 className="h-3.5 w-3.5 text-primary ml-auto" />}
                {savingInternal && <Loader2 className="h-3.5 w-3.5 animate-spin ml-auto" />}
              </div>
              <p className="mt-1 text-[11px] leading-snug text-muted-foreground">
                pgvector in this install&apos;s database. Nothing extra to run, and documents never leave the
                server.
              </p>
            </button>

            <button
              type="button"
              onClick={onConfigureExternal}
              className={cn(
                'text-left rounded-lg border p-3 transition-colors hover:border-primary/40',
                chosen && !isInternal ? 'border-primary/60 bg-primary/5' : '',
              )}
            >
              <div className="flex items-center gap-2">
                <Database className="h-4 w-4 shrink-0" />
                <span className="text-xs font-medium">External vector database</span>
                {chosen && !isInternal && <CheckCircle2 className="h-3.5 w-3.5 text-primary ml-auto" />}
                {!(chosen && !isInternal) && <ArrowRight className="h-3.5 w-3.5 ml-auto" />}
              </div>
              <p className="mt-1 text-[11px] leading-snug text-muted-foreground">
                Qdrant / Milvus / Pinecone / Chroma — self-hosted or cloud, including a collection that already
                exists. Configure it in the External Vector DB tab; the choice is recorded when that connection
                saves.
              </p>
            </button>
          </div>

          {!isInternal && chosen && (
            <div className="text-[11px] text-muted-foreground">
              The bundled pgvector index stays in place as a fallback: keyword search keeps working even if the
              external store is unreachable.
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
