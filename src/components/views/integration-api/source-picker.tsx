'use client'

import { useEffect, useState } from 'react'
import { Check, Database, FileText, KeyRound, Loader2, Lock, Wrench } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { API_KEY_TOOLS } from '@/lib/api-key-scope'

/**
 * Source picker for an API key.
 *
 * WHY CHECKS RATHER THAN A SINGLE "restrict" TOGGLE. The point of scoping is sharing the chatbot
 * with someone who should see SOME of the install. A toggle would only express "all or nothing";
 * the operator's actual intent is "the ERP database and the SOP documents, but not payroll".
 *
 * EMPTY MEANS ALL, AND THE UI SAYS SO. Nothing selected is not "no access" — it is unrestricted,
 * matching every key that existed before scoping. A picker that implied the opposite would make an
 * operator believe they had locked a key down when they had not, which is the failure that matters
 * most here: an over-permissive key that looks restricted.
 *
 * ONLY ACTIVE SOURCES ARE OFFERED, but a scope that names a MISSING one is still shown — as a
 * warning, not silently dropped. The server refuses such a key, so hiding it would leave an operator
 * with a failing key and no visible reason.
 */

interface SourceOption {
  id: string
  name: string
  kind: 'database' | 'document'
  /** Present for documents; shown so an operator can tell two similarly-named files apart. */
  detail?: string
}

export interface SourcePickerValue {
  allowedIntegrationIds: string[]
  allowedDocumentIds: string[]
  allowedTools: string[]
}

export function SourcePicker({
  value,
  onChange,
  disabled = false,
}: {
  value: SourcePickerValue
  onChange: (next: SourcePickerValue) => void
  disabled?: boolean
}) {
  const [databases, setDatabases] = useState<SourceOption[]>([])
  const [documents, setDocuments] = useState<SourceOption[]>([])
  const [loading, setLoading] = useState(true)
  // Sources named by the CURRENT scope that no longer resolve to an active row. Kept so the operator
  // can see WHY the key would be refused rather than watching a checkbox vanish.
  const [missing, setMissing] = useState<string[]>([])

  useEffect(() => {
    let cancelled = false
    async function load() {
      setLoading(true)
      try {
        // Two existing endpoints rather than a new aggregate one: the shapes already exist, and a
        // third endpoint would be a fourth place the same lists are assembled.
        const [intRes, docRes, restRes] = await Promise.all([
          fetch('/api/integrations', { cache: 'no-store' }),
          fetch('/api/documents', { cache: 'no-store' }),
          fetch('/api/data-sources/rest-connectors', { cache: 'no-store' }).catch(() => null),
        ])
        const intJson = await intRes.json().catch(() => ({}))
        const docJson = await docRes.json().catch(() => ({}))
        const restJson = restRes ? await restRes.json().catch(() => ({})) : {}

        const ints: SourceOption[] = (intJson?.integrations ?? intJson?.data ?? [])
          .filter((i: { status?: string }) => !i.status || i.status === 'active')
          .map((i: { id: string; name: string; provider?: string }) => ({
            id: i.id,
            name: i.name,
            kind: 'database' as const,
            detail: i.provider,
          }))
        // REST connectors share the integration scope field, so they are offered in the same group.
        const rests: SourceOption[] = (restJson?.connectors ?? restJson?.data ?? [])
          .filter((c: { isActive?: boolean }) => c.isActive !== false)
          .map((c: { id: string; name: string }) => ({
            id: c.id,
            name: c.name,
            kind: 'database' as const,
            detail: 'REST',
          }))
        const docs: SourceOption[] = (docJson?.documents ?? [])
          .filter((d: { status?: string; isEnabled?: boolean }) => d.status === 'ready' && d.isEnabled !== false)
          .map((d: { id: string; name: string; category?: string | null }) => ({
            id: d.id,
            name: d.name,
            kind: 'document' as const,
            detail: d.category ?? undefined,
          }))

        if (cancelled) return
        const all = [...ints, ...rests]
        setDatabases(all)
        setDocuments(docs)

        // Anything currently selected that is not in the fetched lists is either deleted or not
        // usable. Report it; never quietly remove it from the selection.
        const knownIds = new Set([...all, ...docs].map((o) => o.id))
        const stale = [...value.allowedIntegrationIds, ...value.allowedDocumentIds].filter(
          (id) => !knownIds.has(id),
        )
        setMissing(stale)
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    load()
    return () => {
      cancelled = true
    }
    // Deliberately NOT dependent on `value`: re-fetching the source lists whenever a checkbox is
    // toggled would refetch three endpoints per click.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const totalSelected = value.allowedIntegrationIds.length + value.allowedDocumentIds.length
  const unrestricted = totalSelected === 0 && value.allowedTools.length === 0

  const toggle = (list: 'integration' | 'document', id: string) => {
    const key = list === 'integration' ? 'allowedIntegrationIds' : 'allowedDocumentIds'
    const current = value[key]
    const next = current.includes(id) ? current.filter((x) => x !== id) : [...current, id]
    onChange({ ...value, [key]: next })
  }

  const toggleTool = (tool: string) => {
    const next = value.allowedTools.includes(tool)
      ? value.allowedTools.filter((t) => t !== tool)
      : [...value.allowedTools, tool]
    onChange({ ...value, allowedTools: next })
  }

  if (loading) {
    return (
      <div className="flex items-center gap-2 py-3 text-xs text-muted-foreground">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        Loading available sources…
      </div>
    )
  }

  return (
    <div className="space-y-3">
      <div className="flex items-start justify-between gap-2">
        <div>
          <Label className="text-xs flex items-center gap-1.5">
            {unrestricted ? <KeyRound className="h-3 w-3" /> : <Lock className="h-3 w-3" />}
            Allowed Sources
          </Label>
          <p className="text-[10px] text-muted-foreground mt-0.5">
            {unrestricted
              ? 'Nothing selected = this key can read EVERY source, like a key created before scoping existed.'
              : `This key can read only the ${totalSelected} selected source${totalSelected === 1 ? '' : 's'}.`}
          </p>
        </div>
        {!unrestricted && (
          <Button
            size="sm"
            variant="ghost"
            className="h-6 shrink-0 px-2 text-[10px]"
            disabled={disabled}
            onClick={() =>
              onChange({ allowedIntegrationIds: [], allowedDocumentIds: [], allowedTools: [] })
            }
          >
            Clear (allow all)
          </Button>
        )}
      </div>

      {missing.length > 0 && (
        // The key would be REFUSED by the server while naming a source that no longer exists.
        // Shown rather than silently dropped, because a checkbox that disappears leaves the operator
        // staring at a broken key with nothing to act on.
        <div className="rounded-sm border border-destructive/40 bg-destructive/5 p-2 text-[10px]">
          <div className="font-medium text-destructive">
            {missing.length} selected source{missing.length === 1 ? '' : 's'} no longer available
          </div>
          <p className="text-muted-foreground mt-0.5">
            This key will be REFUSED until they are removed, because answering from the remaining
            sources would silently answer a different question. Untick them below, or save to see the
            exact names.
          </p>
        </div>
      )}

      <SourceGroup
        icon={<Database className="h-3.5 w-3.5 text-muted-foreground" />}
        title="Databases & APIs"
        options={databases}
        selected={value.allowedIntegrationIds}
        disabled={disabled}
        onToggle={(id) => toggle('integration', id)}
        emptyHint="No active data sources. Connect one in Data Sources first."
      />

      <SourceGroup
        icon={<FileText className="h-3.5 w-3.5 text-muted-foreground" />}
        title="Documents"
        options={documents}
        selected={value.allowedDocumentIds}
        disabled={disabled}
        onToggle={(id) => toggle('document', id)}
        emptyHint="No ready documents. Upload one in Knowledge first."
      />

      <div className="space-y-1.5">
        <Label className="text-xs flex items-center gap-1.5">
          <Wrench className="h-3 w-3 text-muted-foreground" />
          Allowed Tools
        </Label>
        <p className="text-[10px] text-muted-foreground">
          {value.allowedTools.length === 0
            ? 'Nothing selected = every tool family (SQL, RAG, REST, Chat).'
            : `Only ${value.allowedTools.join(', ')} may be used — a question needing another tool is refused.`}
        </p>
        <div className="flex flex-wrap gap-1.5">
          {API_KEY_TOOLS.map((tool) => {
            const on = value.allowedTools.includes(tool)
            return (
              <button
                key={tool}
                type="button"
                disabled={disabled}
                onClick={() => toggleTool(tool)}
                className={`rounded-sm border px-2 py-1 text-[10px] transition-colors ${
                  on
                    ? 'border-primary bg-primary/10 text-primary'
                    : 'border-border text-muted-foreground hover:bg-muted'
                } disabled:opacity-50`}
              >
                {on && <Check className="mr-1 inline h-2.5 w-2.5" />}
                {tool}
              </button>
            )
          })}
        </div>
      </div>
    </div>
  )
}

function SourceGroup({
  icon,
  title,
  options,
  selected,
  disabled,
  onToggle,
  emptyHint,
}: {
  icon: React.ReactNode
  title: string
  options: SourceOption[]
  selected: string[]
  disabled: boolean
  onToggle: (id: string) => void
  emptyHint: string
}) {
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-1.5">
        {icon}
        <span className="text-xs font-medium">{title}</span>
        {selected.length > 0 && (
          <Badge variant="secondary" className="text-[10px] px-1.5 py-0">
            {selected.length}
          </Badge>
        )}
        {options.length > 0 && (
          <button
            type="button"
            disabled={disabled}
            className="ml-auto text-[10px] text-muted-foreground hover:text-foreground disabled:opacity-50"
            onClick={() =>
              // Toggling ALL vs NONE: a common intent ("this key gets every database"), and doing it
              // by hand for 40 documents is the kind of friction that makes an operator give up and
              // grant everything instead.
              options.every((o) => selected.includes(o.id))
                ? options.forEach((o) => selected.includes(o.id) && onToggle(o.id))
                : options.forEach((o) => !selected.includes(o.id) && onToggle(o.id))
            }
          >
            {options.every((o) => selected.includes(o.id)) ? 'Select none' : 'Select all'}
          </button>
        )}
      </div>
      {options.length === 0 ? (
        <p className="text-[10px] text-muted-foreground pl-5">{emptyHint}</p>
      ) : (
        <div className="max-h-40 space-y-0.5 overflow-y-auto rounded-sm border p-1.5">
          {options.map((o) => {
            const on = selected.includes(o.id)
            return (
              <button
                key={o.id}
                type="button"
                disabled={disabled}
                onClick={() => onToggle(o.id)}
                className="flex w-full items-center gap-2 rounded-sm px-1.5 py-1 text-left text-[11px] hover:bg-muted disabled:opacity-50"
              >
                <span
                  className={`flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-sm border ${
                    on ? 'border-primary bg-primary text-primary-foreground' : 'border-muted-foreground/40'
                  }`}
                >
                  {on && <Check className="h-2.5 w-2.5" />}
                </span>
                <span className="truncate">{o.name}</span>
                {o.detail && (
                  <span className="ml-auto shrink-0 font-mono text-[10px] text-muted-foreground">
                    {o.detail}
                  </span>
                )}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
