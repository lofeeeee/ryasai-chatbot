'use client'

import { useEffect, useState } from 'react'
import { ArrowRight, Brain, Loader2 } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import type { CogneeDiagnostics } from '@/lib/types'

/**
 * One-line memory status for the Knowledge view, with a link to the place it is configured.
 *
 * WHY THIS REPLACED THE FULL CARD HERE. The complete AI Memory card used to appear TWICE — once in
 * this view and once under AI Configuration — which meant two editable copies of the same settings in
 * two menus. An operator could change one, forget the other, and have no way to tell which was
 * authoritative. Memory now has exactly ONE configuration surface (AI Configuration), because that is
 * where the provider credentials it REUSES are set, and this view keeps what it is actually for:
 * showing whether the knowledge base is being indexed.
 *
 * A link rather than a duplicate: the Knowledge view answers "are my documents searchable", and the
 * one fact it needs is whether memory is working. Sending someone to the settings is honest; showing
 * a second copy of those settings is how the two drift.
 */
export function MemoryStatusCard() {
  const [state, setState] = useState<{
    enabled: boolean
    connected: boolean
    diagnostics: CogneeDiagnostics | null
  } | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    fetch('/api/cognee', { cache: 'no-store' })
      .then((r) => r.json())
      .then((j) => {
        if (cancelled) return
        if (j?.ok) {
          setState({
            enabled: !!j.data?.enabled,
            connected: !!j.data?.connected,
            diagnostics: j.data?.diagnostics ?? null,
          })
        }
      })
      .catch(() => {
        // Non-fatal: the card simply does not render, and the link is absent rather than wrong.
      })
      .finally(() => !cancelled && setLoading(false))
    return () => {
      cancelled = true
    }
  }, [])

  const goToMemory = () =>
    window.dispatchEvent(
      new CustomEvent('navigate-view', { detail: { view: 'ai-config', tab: 'memory' } }),
    )

  if (loading) {
    return (
      <Card className="border-dashed">
        <CardContent className="flex items-center gap-2 px-3 py-2 text-xs text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          Checking memory status…
        </CardContent>
      </Card>
    )
  }

  // The extraction LLM is the component whose failure means "reports healthy, stores nothing", so it
  // is the one worth surfacing here. Other component failures are diagnosed in AI Configuration.
  const llmBroken = (state?.diagnostics?.components ?? []).some(
    (c) => c.name === 'llm_provider' && c.status !== 'healthy',
  )

  return (
    <Card className="border-dashed">
      <CardContent className="flex flex-wrap items-center gap-2 px-3 py-2 text-xs">
        <Brain className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span className="font-medium">AI Memory</span>
        {!state?.enabled ? (
          <Badge variant="outline" className="text-[10px]">
            Off
          </Badge>
        ) : llmBroken ? (
          // The honest label: the sidecar answers, but it cannot extract, so nothing is being stored.
          // "Connected" here would be the green badge over a product that stores nothing.
          <Badge variant="destructive" className="text-[10px]">
            Cannot store
          </Badge>
        ) : (
          <Badge variant={state.connected ? 'default' : 'destructive'} className="text-[10px]">
            {state.connected ? 'Active' : 'Unreachable'}
          </Badge>
        )}
        <span className="text-[10px] text-muted-foreground">
          {!state?.enabled
            ? '— documents are searchable by keyword and embeddings, without cross-session memory'
            : llmBroken
              ? '— the memory model is not usable; configure it in AI Configuration'
              : '— cross-session memory and knowledge graph are running'}
        </span>
        <Button
          size="sm"
          variant="ghost"
          className="ml-auto h-6 shrink-0 px-2 text-[10px]"
          onClick={goToMemory}
        >
          Configure
          <ArrowRight className="ml-1 h-3 w-3" />
        </Button>
      </CardContent>
    </Card>
  )
}
