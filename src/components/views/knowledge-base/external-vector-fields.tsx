'use client'

import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { VECTOR_STORE_PRESETS, getVectorStorePreset } from '@/lib/db-provider-presets'
import { EMBEDDING_DIMENSIONS } from '@/lib/constants'

/**
 * The EXTERNAL vector-database fields, in one place.
 *
 * WHY SHARED. Two surfaces collect these values — the setup wizard's Knowledge Storage step (so a first run can
 * answer "where does knowledge live" without leaving the wizard) and Knowledge → External Vector DB (where it is
 * maintained afterwards). Written twice, they drift: one gains a provider, one forgets to reset the base URL on a
 * provider switch, and the two disagree about a store that only has one definition. This repo already paid for that
 * pattern once, when the same AI Memory card was rendered by two menus.
 *
 * `INTERNAL` is deliberately NOT offered here. The bundled PostgreSQL is not an external store, and the decision to
 * use it belongs to the Storage surface, which records it explicitly. Listing it here as one of "the providers" is
 * what made the two ideas look interchangeable in the first place.
 */
export interface ExternalVectorFieldsValue {
  provider: string
  baseUrl: string
  collectionName: string
  vectorSize: string
  distance: string
  apiKey: string
}

export function ExternalVectorStoreFields({
  value,
  onChange,
  storedVectorSize,
  storedModel,
  apiKeyPlaceholder,
  idPrefix = 'vs',
}: {
  value: ExternalVectorFieldsValue
  onChange: (patch: Partial<ExternalVectorFieldsValue>) => void
  /** The dimension the CHUNKS actually hold, and the model they were embedded with — measured, not configured. */
  storedVectorSize: number | null
  storedModel: string | null
  apiKeyPlaceholder?: string
  /** Distinct input ids when two copies can be mounted at once (wizard + tab). */
  idPrefix?: string
}) {
  const preset = getVectorStorePreset(value.provider)
  const needsApiKey = preset?.needsApiKey ?? false

  const handleProviderChange = (id: string) => {
    const p = getVectorStorePreset(id)
    // A base URL belongs to exactly one provider — a Qdrant URL can never serve a Milvus config. Always swap it to
    // the new provider's default; leaving the old provider's URL behind produced configs that saved and then failed
    // at test/search time with a confusing cross-provider error.
    onChange({ provider: id, baseUrl: p?.baseUrlPlaceholder ?? '', vectorSize: String(p?.defaultVectorSize ?? EMBEDDING_DIMENSIONS) })
  }

  const externalPresets = VECTOR_STORE_PRESETS.filter((p) => p.backend !== 'INTERNAL')

  return (
    <>
      <div className="space-y-1.5">
        <Label htmlFor={`${idPrefix}-provider`}>Provider</Label>
        {/* Always controlled. `value.provider` starts as '' and Radix renders the placeholder for '' — passing
            `undefined` until a preset resolved made Radix's useControllableState see a component that switched from
            uncontrolled to controlled when the load effect seeded a backend, which logs a React warning on every
            healthy load. Same visible behaviour, no lifetime switch. */}
        <Select value={value.provider} onValueChange={handleProviderChange}>
          <SelectTrigger id={`${idPrefix}-provider`}>
            <SelectValue placeholder="Select a vector database" />
          </SelectTrigger>
          <SelectContent>
            {externalPresets.map((p) => (
              <SelectItem key={p.id} value={p.id}>
                {p.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {preset?.hint && <p className="text-xs text-warning">{preset.hint}</p>}
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={`${idPrefix}-base`}>Base URL</Label>
        <Input
          id={`${idPrefix}-base`}
          value={value.baseUrl}
          onChange={(e) => onChange({ baseUrl: e.target.value })}
          placeholder={preset?.baseUrlPlaceholder ?? ''}
          className="font-mono text-sm"
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={`${idPrefix}-collection`}>Collection</Label>
        <Input
          id={`${idPrefix}-collection`}
          value={value.collectionName}
          onChange={(e) => onChange({ collectionName: e.target.value })}
          className="font-mono text-sm"
        />
        <p className="text-[11px] leading-snug text-muted-foreground">
          Point this at a collection that already exists to keep using vectors you have already indexed.
        </p>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div className="space-y-1.5">
          <Label htmlFor={`${idPrefix}-dim`}>Dimension</Label>
          <Input
            id={`${idPrefix}-dim`}
            value={value.vectorSize}
            onChange={(e) => onChange({ vectorSize: e.target.value })}
            inputMode="numeric"
          />
          {/*
            THE DIVERGENCE, SHOWN WHERE IT CAN BE FIXED. MEASURED IN UAT: this field read 1536 while the stored
            vectors were 384-dimensional, so semantic scoring was silently inert — every score 0, search quietly
            lexical-only — and this panel was the one place an admin would notice. It advertised a single
            consistent-looking number instead. The text below states the measured truth whenever it disagrees with
            the configured value, including WHAT the chunks were embedded with, because that is what the operator
            needs in order to re-embed them.
          */}
          {storedVectorSize !== null && storedVectorSize !== Number(value.vectorSize) ? (
            <p className="text-[11px] leading-snug text-amber-600">
              Stored vectors are <strong>{storedVectorSize}-dimensional</strong>
              {storedModel ? ` (${storedModel})` : ''} — not {value.vectorSize}. Semantic scoring is inert until the
              documents are re-embedded: retrieval only compares a chunk whose embedding model matches the
              query&apos;s, so every similarity is currently 0 and search is lexical-only.
            </p>
          ) : storedVectorSize !== null ? (
            <p className="text-[11px] leading-snug text-muted-foreground">
              Stored vectors: {storedVectorSize}-dimensional{storedModel ? ` (${storedModel})` : ''}.
            </p>
          ) : (
            <p className="text-[11px] leading-snug text-muted-foreground">
              No chunks embedded yet, so the stored dimension is unknown.
            </p>
          )}
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`${idPrefix}-distance`}>Distance</Label>
          <Input
            id={`${idPrefix}-distance`}
            value={value.distance}
            onChange={(e) => onChange({ distance: e.target.value })}
          />
        </div>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={`${idPrefix}-key`}>
          API Key{needsApiKey && <span className="text-destructive"> *</span>}
        </Label>
        <Input
          id={`${idPrefix}-key`}
          value={value.apiKey}
          onChange={(e) => onChange({ apiKey: e.target.value })}
          placeholder={apiKeyPlaceholder ?? (needsApiKey ? 'required' : 'optional')}
          className="font-mono text-sm"
          autoComplete="new-password"
        />
      </div>
    </>
  )
}
