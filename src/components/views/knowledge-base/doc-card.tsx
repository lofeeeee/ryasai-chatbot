'use client'

import { useEffect, useRef, useState } from 'react'
import { Eye, Trash2, Loader2, RefreshCw } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { cn } from '@/lib/utils'
import type { DocumentItem } from '@/lib/types'
import { fileIconFor, STATUS_BADGE, categoryColor } from './helpers'

export function DocCard({
  doc,
  deleting,
  onDetail,
  onDelete,
  onToggle,
}: {
  doc: DocumentItem
  deleting?: boolean
  onDetail: () => void
  onDelete: () => void
  onToggle: (checked: boolean) => void
}) {
  const [toggling, setToggling] = useState(false)
  const [retrying, setRetrying] = useState(false)
  // Local status override after a reprocess — the card shows Processing
  // immediately, then polling refreshes it with the server's answer.
  const [override, setOverride] = useState<{ status?: string; cognifyStatus?: string | null }>({})
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  /**
   * How long the card has been showing an optimistic "processing" state.
   *
   * WHY THIS EXISTS. The card used to schedule EXACTLY ONE refresh, 8 seconds after a reprocess. Real
   * cognify takes 45-148s (measured on this deployment), so the single refresh always landed while the
   * job was still running, and the card then displayed "processing" FOREVER — the DB said `completed`
   * and the screen said the opposite, with nothing to correct it. A user reported exactly that:
   * "kenapa processing sangat lamaaa" on a document that had finished.
   *
   * So the card now polls until the state is terminal, and this counter drives the honest progress text
   * while it waits.
   */
  const [elapsed, setElapsed] = useState(0)

  useEffect(() => {
    return () => {
      if (pollTimer.current) clearTimeout(pollTimer.current)
    }
  }, [])

  const isFailed = doc.status === 'error' || doc.cognifyStatus === 'failed'
  const effectiveDoc: DocumentItem = {
    ...doc,
    status: override.status ?? doc.status,
    cognifyStatus: override.cognifyStatus !== undefined ? override.cognifyStatus : doc.cognifyStatus,
  }

  /**
   * `completed` and `failed` are the only terminal states of the cognify step. `processing` and null
   * both mean "still to come" — null because a row created before the step was queued has no value yet,
   * and treating that as terminal is how the card would stop polling before the job even started.
   */
  const cognifySettled =
    effectiveDoc.cognifyStatus === 'completed' || effectiveDoc.cognifyStatus === 'failed'

  useEffect(() => {
    if (cognifySettled) {
      setElapsed(0)
      return
    }
    if (!override.cognifyStatus) return
    const t = setInterval(() => setElapsed((n) => n + 1), 1000)
    return () => clearInterval(t)
  }, [cognifySettled, override.cognifyStatus])

  async function handleRetry() {
    if (retrying) return
    setRetrying(true)
    try {
      const res = await fetch(`/api/documents/${doc.id}/reprocess`, { method: 'POST' })
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null
        console.error(body?.error ?? 'Reprocess failed.')
        return
      }
      setOverride({ status: 'ready', cognifyStatus: 'processing' })

      /*
       * POLL UNTIL TERMINAL, with a bound.
       *
       * The old code scheduled ONE refresh at 8s and stopped. Cognify measures 45-148s here, so the
       * single look always saw `processing` and the card kept that verdict indefinitely.
       *
       * The ceiling matters as much as the loop: an unbounded poll against a job that died without
       * writing a status would spin forever. After the ceiling the card stops claiming to know and says
       * so, rather than pretending "processing" is still news.
       */
      const POLL_INTERVAL_MS = 5_000
      const POLL_CEILING_MS = 10 * 60_000
      const startedAt = Date.now()

      const pollOnce = async () => {
        try {
          const detail = await fetch(`/api/documents/${doc.id}`, { cache: 'no-store' })
          if (detail.ok) {
            const data = (await detail.json()) as {
              document?: { status?: string; cognifyStatus?: string | null }
            }
            if (data.document) {
              const next = {
                status: data.document.status,
                cognifyStatus: data.document.cognifyStatus ?? null,
              }
              setOverride(next)
              // Stop as soon as the server reports a terminal state — continuing would be busywork
              // against a settled row.
              if (next.cognifyStatus === 'completed' || next.cognifyStatus === 'failed') return
            }
          }
        } catch {
          // Transient: keep polling. The list refetch on remount is the final reconciliation.
        }
        if (Date.now() - startedAt < POLL_CEILING_MS) {
          pollTimer.current = setTimeout(pollOnce, POLL_INTERVAL_MS)
        }
      }
      /*
       * The FIRST tick. The loop then reschedules ITSELF while the state is unsettled, so there are
       * deliberately two `setTimeout(pollOnce, POLL_INTERVAL_MS)` sites: this entry point and the
       * continue-branch inside. There is exactly one CHAIN — adding a `void pollOnce()` here as well
       * would start a second, independent chain against the same document.
       */
      pollTimer.current = setTimeout(pollOnce, POLL_INTERVAL_MS)
    } finally {
      setRetrying(false)
    }
  }

  const { Icon, className: iconCls } = fileIconFor(effectiveDoc.type)
  const status = STATUS_BADGE[effectiveDoc.status] ?? STATUS_BADGE.error
  const catBadge = categoryColor(effectiveDoc.category ?? 'Uncategorized')
  const isEnabled = effectiveDoc.isEnabled !== false

  return (
    <Card className="flex flex-col">
      <CardHeader className="pb-2">
        <div className="flex items-start gap-2.5">
          <div
            className={cn(
              'h-8 w-8 rounded-lg flex items-center justify-center shrink-0',
              iconCls,
            )}
          >
            <Icon className="h-4 w-4" />
          </div>
          <div className="min-w-0 flex-1">
            <CardTitle className="text-xs leading-snug break-words line-clamp-1">
              {effectiveDoc.name}
            </CardTitle>
            <div className="mt-1 flex flex-wrap items-center gap-1.5">
              <Badge variant="outline" className={cn('text-[10px]', catBadge)}>
                {effectiveDoc.category ?? 'Uncategorized'}
              </Badge>
              <Badge variant="outline" className={cn('text-[10px]', status.className)}>
                {status.label}
              </Badge>
              {effectiveDoc.cognifyStatus && (
                <Badge
                  variant="outline"
                  className={cn(
                    'text-[10px]',
                    effectiveDoc.cognifyStatus === 'completed' && 'bg-primary/15 text-primary border-primary/20',
                    effectiveDoc.cognifyStatus === 'processing' && 'bg-warning/15 text-warning border-warning/20',
                    effectiveDoc.cognifyStatus === 'failed' && 'bg-destructive/15 text-destructive border-destructive/20',
                  )}
                >
                  {/*
                    Say WHAT is happening and HOW LONG it takes, once it has run long enough to be
                    worth explaining. The bare word "processing" is what produced the user report
                    "kenapa processing sangat lamaaa" — it gave no scale, so 90 seconds of normal work
                    looked like a hang.

                    The elapsed counter appears after 20s, which is past the short end of the measured
                    45-148s range for this step and therefore the point where a wait starts to feel
                    unexplained rather than merely slow.
                  */}
                  {effectiveDoc.cognifyStatus === 'completed'
                    ? 'Graph'
                    : effectiveDoc.cognifyStatus === 'processing'
                      ? elapsed >= 20
                        ? `Building graph · ${elapsed}s`
                        : 'Building graph'
                      : effectiveDoc.cognifyStatus}
                </Badge>
              )}
            </div>
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            <span className="text-[10px] font-medium text-muted-foreground">
              {isEnabled ? 'ON' : 'OFF'}
            </span>
            <Switch
              checked={isEnabled}
              disabled={toggling}
              onCheckedChange={async (checked) => {
                setToggling(true)
                try {
                  await onToggle(checked)
                } finally {
                  setToggling(false)
                }
              }}
            />
          </div>
        </div>
      </CardHeader>

      <CardContent className="flex-1 flex flex-col gap-2 pt-0">
        {isFailed && (
          <Button
            size="sm"
            variant="outline"
            onClick={handleRetry}
            disabled={retrying}
            className="w-full text-xs h-7 col-span-2"
            icon={retrying ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <RefreshCw className="h-3 w-3" />
            )}
          >
            {retrying ? 'Queuing' : 'Retry Processing'}
          </Button>
        )}
        <div className="mt-auto grid grid-cols-2 gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={onDetail}
            className="text-xs h-7"
            icon={<Eye className="h-3 w-3" />}
          >
            Details
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={onDelete}
            disabled={deleting}
            className="text-xs h-7 text-destructive hover:text-destructive hover:bg-destructive/10"
            icon={deleting ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <Trash2 className="h-3 w-3" />
            )}
          >
            {deleting ? 'Deleting' : 'Delete'}
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
