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
import type { EmbeddingStampVerdict } from '@/lib/embedding-stamp'

/**
 * The EXTERNAL vector-database fields, in one place.
 *
 * WHY SHARED. This component was written so the collection form could be rendered by more than one surface — the
 * setup wizard's Knowledge Storage step and Knowledge → External Vector DB — so the two could not drift into
 * disagreeing about what a provider switch does to the base URL. It has ONE consumer today
 * (`vector-store-panel.tsx`); the reason it stays extracted is that the alternative is re-deriving "a base URL
 * belongs to exactly one provider" at each future call site, which is the drift this was extracted to prevent.
 * An earlier revision of this comment stated both surfaces were live; that was already stale when it was written.
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
  configuredModel,
  stampVerdict,
  apiKeyPlaceholder,
  idPrefix = 'vs',
}: {
  value: ExternalVectorFieldsValue
  onChange: (patch: Partial<ExternalVectorFieldsValue>) => void
  /** The dimension the CHUNKS actually hold, and the model they were embedded with — measured, not configured. */
  storedVectorSize: number | null
  storedModel: string | null
  /**
   * The model a QUERY would be embedded with right now, resolved server-side from the same config the write path
   * uses. Null when nothing is configured (or no org context) — "cannot tell", never a guess.
   */
  configuredModel: string | null
  /**
   * The server's verdict on `storedModel` vs `configuredModel`. Passed in rather than recomputed here so the
   * comparison is made in exactly one place, with the retriever's own strictness (`compareEmbeddingStamps`
   * compares exact strings — no prefix normalisation, because the retriever does not normalise either).
   */
  stampVerdict: EmbeddingStampVerdict
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

            THE SECOND BRANCH IS THE QUIET HALF OF THE SAME DEFECT. A width mismatch is loud and arithmetic; a
            MODEL mismatch at the SAME width is invisible on this form, because every number on it agrees. The
            retriever does not compare widths — it compares `chunk.embeddingModel === queryEmbedding.model` — so
            two different 384-dimensional models fail exactly as hard as 384-vs-1536, and the operator previously
            had no way to learn that here. The stored model WAS printed in the neutral line below, but printed is
            not compared: on a same-width install the panel looked healthy while every semantic score was 0.
            `stampVerdict` is the server's own comparison of those two strings (see `embedding-stamp.ts`), so this
            renders the same equality the retriever will apply rather than a friendlier one.
          */}
          {storedVectorSize !== null && storedVectorSize !== Number(value.vectorSize) ? (
            <p className="text-[11px] leading-snug text-amber-600">
              Stored vectors are <strong>{storedVectorSize}-dimensional</strong>
              {storedModel ? ` (${storedModel})` : ''} — not {value.vectorSize}. Semantic scoring is inert until the
              documents are re-embedded: retrieval only compares a chunk whose embedding model matches the
              query&apos;s, so every similarity is currently 0 and search is lexical-only.
            </p>
          ) : stampVerdict === 'mismatch' ? (
            <p className="text-[11px] leading-snug text-amber-600">
              The stored vectors carry a different model stamp — <strong>{storedModel}</strong> stored,{' '}
              <strong>{configuredModel}</strong> configured. Same width, so everything above agrees, but retrieval
              only scores a chunk whose embedding model matches the query&apos;s: semantic similarity is currently 0
              on every result and search is lexical-only. Re-embed the documents (Rebuild Embeddings in the header)
              to score them with the configured model.
            </p>
          ) : storedVectorSize !== null ? (
            <p className="text-[11px] leading-snug text-muted-foreground">
              Stored vectors: {storedVectorSize}-dimensional{storedModel ? ` (${storedModel})` : ''}
              {stampVerdict === 'match' ? ' — matches the configured embedding model.' : ''}
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
