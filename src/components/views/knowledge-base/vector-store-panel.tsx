'use client'

import { useEffect, useState } from 'react'
import { Layers, AlertCircle, Loader2, CheckCircle2 } from 'lucide-react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { getVectorStorePreset } from '@/lib/db-provider-presets'
import { extractError } from '@/lib/extract-error'
import { EMBEDDING_DIMENSIONS } from '@/lib/constants'
import {
  ExternalVectorStoreFields,
  type ExternalVectorFieldsValue,
} from './external-vector-fields'

/**
 * Knowledge → External Vector DB: the connection details for a store OUTSIDE this install.
 *
 * WHAT CHANGED AND WHY. This panel used to be called "Vector DB" and listed the bundled PostgreSQL as one of the
 * "providers", so the question "which store does our knowledge base live in?" and "how do I connect a Qdrant?"
 * were the same dropdown. They are different decisions with different consequences, and mixing them is what left
 * installs embedding into a store nobody had deliberately picked. The bundled PostgreSQL is now chosen (and
 * recorded) on the Storage tab; this tab only ever configures an EXTERNAL store, and saving here is what records
 * that the external store is the choice.
 */
export function VectorStorePanel({ onSaved }: { onSaved?: () => void | Promise<void> } = {}) {
  const [fields, setFields] = useState<ExternalVectorFieldsValue>({
    // Empty on purpose: nothing external has been chosen until the operator picks one, and pre-selecting Qdrant
    // would put a live-looking URL in front of someone who may only be here to look.
    provider: '',
    baseUrl: '',
    collectionName: 'ryasai_chunks',
    vectorSize: String(EMBEDDING_DIMENSIONS),
    distance: 'Cosine',
    apiKey: '',
  })
  /*
   * The dimension the CHUNKS actually hold, and the model they were embedded with.
   *
   * MEASURED IN UAT: this panel showed the CONFIGURED 1536 while the stored vectors were 384-dimensional
   * (`paraphrase-multilingual-MiniLM-L12-v2`). Retrieval only compares a chunk whose embedding model matches the
   * query's, so every semantic score was 0 and search silently fell back to lexical-only — while this panel, the one
   * place an admin would fix it, advertised a single consistent-looking number. The API was changed to report both;
   * showing only one here would leave the divergence invisible exactly where it matters.
   */
  const [storedVectorSize, setStoredVectorSize] = useState<number | null>(null)
  const [storedModel, setStoredModel] = useState<string | null>(null)
  const [configuredInternal, setConfiguredInternal] = useState(false)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [loadError, setLoadError] = useState(false)

  const patch = (p: Partial<ExternalVectorFieldsValue>) => setFields((f) => ({ ...f, ...p }))
  const preset = getVectorStorePreset(fields.provider)
  const needsApiKey = preset?.needsApiKey ?? false

  useEffect(() => {
    let cancelled = false
    fetch('/api/vector-store', { cache: 'no-store' })
      .then((res) => res.json())
      .then((json) => {
        if (cancelled) return
        /*
         * ANY absence of a usable answer sets `loadError` — not just a thrown fetch.
         *
         * This used to `return` silently when `json.ok` was false, and `handleApiError` reports every
         * server-side failure as exactly that (a 500 with `{ error }`). The component then rendered its
         * DEFAULTS as though they were the org's saved configuration, with no banner and the Save button
         * ENABLED. Pressing Save would write those placeholder values over a real Qdrant/Milvus/Pinecone/Chroma
         * config, silently. The loadError banner exists precisely to stop this ("Saving may overwrite existing
         * configuration"), and the one path that most needed it was the one path that skipped it.
         */
        if (!json?.ok || !json.data) {
          setLoadError(true)
          return
        }
        const stored = String(json.data.provider ?? 'INTERNAL')
        const storedBackend = getVectorStorePreset(stored)?.backend ?? stored
        /*
         * The stored provider SEEDS the form only when it is external. When the install is on the bundled
         * PostgreSQL there is nothing external to show, and seeding "INTERNAL" (which is no longer one of the
         * options) would leave the select claiming a provider the operator cannot see. The banner above the form
         * says which case this is, so an empty form reads as "not configured", not as "we forgot".
         */
        setConfiguredInternal(storedBackend === 'INTERNAL')
        if (storedBackend !== 'INTERNAL') {
          setFields((f) => ({
            ...f,
            provider: stored,
            baseUrl: json.data.baseUrl ?? '',
            collectionName: json.data.collectionName ?? 'ryasai_chunks',
            vectorSize: String(json.data.vectorSize ?? EMBEDDING_DIMENSIONS),
            distance: json.data.distance ?? 'Cosine',
          }))
        }
        setStoredVectorSize(typeof json.data.storedVectorSize === 'number' ? json.data.storedVectorSize : null)
        setStoredModel(typeof json.data.storedEmbeddingModel === 'string' ? json.data.storedEmbeddingModel : null)
      })
      .catch(() => {
        if (!cancelled) setLoadError(true)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const save = async () => {
    if (!preset || preset.backend === 'INTERNAL') {
      toast.error('Select a vector database provider first.')
      return
    }
    if (needsApiKey && !fields.apiKey.trim()) {
      toast.error('API key required for this provider.')
      return
    }
    setSaving(true)
    try {
      const res = await fetch('/api/vector-store', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: fields.provider,
          baseUrl: fields.baseUrl,
          apiKey: fields.apiKey || undefined,
          collectionName: fields.collectionName,
          vectorSize: Number(fields.vectorSize) || EMBEDDING_DIMENSIONS,
          distance: fields.distance,
        }),
      })
      const json = await res.json()
      if (!res.ok || !json.ok) throw new Error(extractError(json.error, 'Failed to save.'))
      patch({ apiKey: '' })
      setConfiguredInternal(false)
      toast.success('External vector database saved.', {
        description: 'Knowledge uploads are now embedded into it.',
      })
      await onSaved?.()
    } catch (e) {
      toast.error('Failed to save vector DB', {
        description: e instanceof Error ? e.message : undefined,
      })
    } finally {
      setSaving(false)
    }
  }

  const test = async () => {
    setTesting(true)
    try {
      const res = await fetch('/api/vector-store', { method: 'POST' })
      const json = await res.json()
      if (!res.ok || !json.ok) throw new Error(extractError(json.error, 'Failed to test vector DB.'))
      toast.success('Vector DB ready.', {
        description: json.data?.collectionName ?? json.data?.provider,
      })
    } catch (e) {
      toast.error('Vector DB not ready', {
        description: e instanceof Error ? e.message : undefined,
      })
    } finally {
      setTesting(false)
    }
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center gap-2">
          <div className="h-9 w-9 rounded-lg bg-primary/10 text-primary flex items-center justify-center">
            <Layers className="h-4.5 w-4.5" />
          </div>
          <div>
            <CardTitle className="text-xs">External Vector DB</CardTitle>
            <p className="text-xs text-muted-foreground">
              Qdrant / Milvus / Pinecone / Chroma, self-hosted or cloud. Saving here makes it this install&apos;s
              knowledge store.
            </p>
          </div>
        </div>
      </CardHeader>
      <CardContent className="grid gap-3 md:grid-cols-2">
        {loadError && (
          <div className="md:col-span-2 rounded-md border border-destructive/40 bg-destructive/10 p-3 flex items-start gap-2">
            <AlertCircle className="h-4 w-4 text-destructive shrink-0 mt-0.5" />
            <div className="text-xs text-destructive">
              Failed to load vector DB configuration. Saving may overwrite existing configuration. Reload the page to try again.
            </div>
          </div>
        )}
        {!loadError && configuredInternal && (
          <div className="md:col-span-2 rounded-md border bg-muted/40 p-3 text-xs text-muted-foreground">
            Knowledge is currently stored in the bundled PostgreSQL. Choose an external provider below and save to
            move it — the bundled pgvector index stays in place as a keyword-search fallback.
          </div>
        )}
        <ExternalVectorStoreFields
          value={fields}
          onChange={patch}
          storedVectorSize={storedVectorSize}
          storedModel={storedModel}
          apiKeyPlaceholder={configuredInternal ? 'required' : undefined}
        />
        <div className="flex justify-end gap-2 md:col-span-2">
          <Button
            variant="outline"
            size="sm"
            onClick={test}
            disabled={testing || configuredInternal}
            icon={testing ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
          >
            Test
          </Button>
          <Button
            size="sm"
            onClick={save}
            disabled={saving || loadError}
            icon={saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
          >
            Save
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
