'use client'

import { useState } from 'react'
import { Loader2, CheckCircle2, ArrowLeft, Database, HardDrive } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Progress } from '@/components/ui/progress'
import { Textarea } from '@/components/ui/textarea'
import { toast } from 'sonner'
import { extractError } from '@/lib/extract-error'

const STEPS = ['LLM API', 'Test Model', 'Knowledge Storage', 'Document', 'Data Source', 'Test Chat'] as const

interface SetupViewProps {
  onDone: () => void
}

export function SetupView({ onDone }: SetupViewProps) {
  const [step, setStep] = useState(0)
  const next = () => setStep((s) => s + 1)
  const prev = () => setStep((s) => Math.max(0, s - 1))

  async function finish() {
    const res = await fetch('/api/setup/complete', { method: 'POST' })
    if (!res.ok) {
      toast.error('Failed to complete setup.')
      return
    }
    onDone()
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-muted/30 p-4">
      <Card className="w-full max-w-lg">
        <CardHeader>
          <CardTitle>Setup Wizard — {STEPS[step]}</CardTitle>
          <CardDescription>
            Step {step + 1} of {STEPS.length}
          </CardDescription>
          <Progress value={((step + 1) / STEPS.length) * 100} className="mt-2" />
        </CardHeader>
        <CardContent className="min-h-[280px]">
          {step === 0 && <LlmStep onNext={next} />}
          {step === 1 && <TestModelStep onNext={next} onPrev={prev} />}
          {step === 2 && <KnowledgeStorageStep onNext={next} onPrev={prev} />}
          {step === 3 && <DocumentStep onNext={next} onPrev={prev} />}
          {step === 4 && <DataSourceStep onNext={next} onPrev={prev} />}
          {step === 5 && <TestChatStep onFinish={finish} onPrev={prev} />}
        </CardContent>
      </Card>
    </div>
  )
}

/* ------------------------------ Step 0: LLM ------------------------------ */

function LlmStep({ onNext }: { onNext: () => void }) {
  const [provider] = useState('openai-compatible')
  const [baseUrl, setBaseUrl] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [model, setModel] = useState('')
  const [saving, setSaving] = useState(false)

  async function handleSave() {
    setSaving(true)
    try {
      const res = await fetch('/api/llm-config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider,
          baseUrl,
          apiKey: apiKey || undefined,
          model: model || undefined,
        }),
      })
      if (!res.ok) {
        toast.error('Failed to save LLM configuration')
        return
      }
      toast.success('LLM configuration saved')
    } catch {
      toast.error('Failed to save LLM configuration')
      return
    } finally {
      setSaving(false)
    }
    onNext()
  }

  return (
    <div className="space-y-4">
      <p className="text-xs text-muted-foreground">
        Connect an LLM provider (OpenAI-compatible). You can skip this step and configure it
        later in AI Configuration.
      </p>
      <div className="space-y-2">
        <Label htmlFor="llm-base">Base URL</Label>
        <Input
          id="llm-base"
          placeholder="https://api.openai.com/v1"
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="llm-key">API Key</Label>
        <Input
          id="llm-key"
          type="password"
          placeholder="sk-..."
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="llm-model">Model</Label>
        <Input
          id="llm-model"
          placeholder="gpt-4o-mini"
          value={model}
          onChange={(e) => setModel(e.target.value)}
        />
      </div>
      <div className="flex gap-2">
        <Button variant="outline" className="flex-1" onClick={onNext} disabled={saving}>
          Skip
        </Button>
        <Button
          className="flex-1"
          icon={saving ? <Loader2 className="h-4 w-4 animate-spin" /> : undefined}
          onClick={handleSave}
          disabled={saving}
        >
          Save & Continue
        </Button>
      </div>
    </div>
  )
}

/* --------------------------- Step 2: Test Model -------------------------- */

function TestModelStep({ onNext, onPrev }: { onNext: () => void; onPrev: () => void }) {
  const [syncing, setSyncing] = useState(false)
  const [modelCount, setModelCount] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function handleSync() {
    setSyncing(true)
    setError(null)
    try {
      const res = await fetch('/api/llm-config/models', { method: 'POST' })
      const data = await res.json()
      if (!res.ok) throw new Error(data?.error || 'Failed')
      setModelCount(Array.isArray(data?.data?.models) ? data.data.models.length : 0)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed')
    } finally {
      setSyncing(false)
    }
  }

  return (
    <div className="space-y-4">
      <p className="text-xs text-muted-foreground">
        Verify the LLM connection by syncing the model list.
      </p>
      {modelCount !== null && (
        <div className="flex items-center gap-2 text-xs text-success">
          <CheckCircle2 className="h-4 w-4" />
          {modelCount} models available.
        </div>
      )}
      {error && <p className="text-xs text-destructive">{error}</p>}
      <div className="flex gap-2">
        <Button variant="outline" icon={<ArrowLeft className="h-4 w-4" />} onClick={onPrev}>
          Back
        </Button>
        <Button variant="outline" className="flex-1" onClick={onNext}>
          Skip
        </Button>
        <Button
          className="flex-1"
          icon={syncing ? <Loader2 className="h-4 w-4 animate-spin" /> : undefined}
          onClick={handleSync}
          disabled={syncing}
        >
          Test Connection
        </Button>
      </div>
      {modelCount !== null && (
        <Button variant="ghost" className="w-full" onClick={onNext}>
          Continue →
        </Button>
      )}
    </div>
  )
}

/* ------------------------ Step 3: Knowledge Storage ---------------------- */

/**
 * The first-run half of the storage decision; Knowledge → Storage is the same control afterwards.
 *
 * WHY IT IS IN THE WIZARD. The upload route refuses documents until a storage choice exists, and this wizard
 * contains a Document step — so a first run that skipped the choice would offer an upload that 503s, which reads as
 * "the product is broken" rather than "you have not finished setting up". It is also the honest place to show the
 * AI-Memory / Knowledge-storage distinction for the first time: the two look alike and are not the same thing.
 *
 * It cannot be skipped. Both answers are one click and neither is destructive — "bundled PostgreSQL" is a complete,
 * valid answer — so a Skip button would only let someone defer a decision that gates the next step.
 */
function KnowledgeStorageStep({ onNext, onPrev }: { onNext: () => void; onPrev: () => void }) {
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  async function chooseInternal() {
    setSaving(true)
    try {
      const res = await fetch('/api/vector-store', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: 'INTERNAL', baseUrl: '' }),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) {
        toast.error(extractError(json.error, 'Failed to save the storage choice'))
        return
      }
      setSaved(true)
      toast.success('Knowledge storage saved')
      onNext()
    } catch {
      toast.error('Failed to save the storage choice')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-4">
      <p className="text-xs text-muted-foreground">
        Two different things are stored, and only one of them is a choice. <strong>AI Memory</strong> (conversation
        memory and the knowledge graph) always uses this install&apos;s bundled PostgreSQL. <strong>Knowledge
        storage</strong> — where uploaded documents are embedded for search — is yours to pick here, and document
        upload stays blocked until it is set.
      </p>
      <div className="grid gap-2">
        <button
          type="button"
          onClick={chooseInternal}
          disabled={saving || saved}
          className="text-left rounded-lg border p-3 transition-colors hover:border-primary/40 disabled:opacity-60"
        >
          <div className="flex items-center gap-2">
            <HardDrive className="h-4 w-4 shrink-0" />
            <span className="text-xs font-medium">Bundled PostgreSQL (recommended)</span>
            {saving && <Loader2 className="h-3.5 w-3.5 animate-spin ml-auto" />}
            {saved && <CheckCircle2 className="h-3.5 w-3.5 text-success ml-auto" />}
          </div>
          <p className="mt-1 text-[11px] leading-snug text-muted-foreground">
            pgvector in this install&apos;s own database. Nothing extra to run and documents never leave the
            server. This is what almost every install should use.
          </p>
        </button>
        <div className="rounded-lg border p-3 text-[11px] leading-snug text-muted-foreground">
          <div className="flex items-center gap-2">
            <Database className="h-4 w-4 shrink-0" />
            <span className="text-xs font-medium text-foreground">External vector database</span>
          </div>
          <p className="mt-1">
            Qdrant, Milvus, Pinecone or Chroma — including a collection you have already indexed. Choose this in
            Knowledge → Storage after setup; saving the connection there records the choice, and uploads stay
            blocked until it is saved.
          </p>
        </div>
      </div>
      <div className="flex gap-2">
        <Button variant="outline" icon={<ArrowLeft className="h-4 w-4" />} onClick={onPrev} disabled={saving}>
          Back
        </Button>
        <Button className="flex-1" onClick={onNext} disabled={saving || !saved}>
          Continue →
        </Button>
      </div>
      {!saved && (
        <p className="text-[11px] text-muted-foreground">
          Choose a storage option to continue — the next step uploads a document, and the upload is refused until
          the choice is saved.
        </p>
      )}
    </div>
  )
}

/* --------------------------- Step 4: Document ---------------------------- */

function DocumentStep({ onNext, onPrev }: { onNext: () => void; onPrev: () => void }) {
  const [uploading, setUploading] = useState(false)
  const [uploaded, setUploaded] = useState(false)
  const inputId = 'setup-doc-input'

  async function handleUpload(file: File) {
    setUploading(true)
    try {
      const form = new FormData()
      form.append('file', file)
      const res = await fetch('/api/documents', { method: 'POST', body: form })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        toast.error(extractError(err.error, 'Failed to upload'))
        return
      }
      setUploaded(true)
      toast.success('Document uploaded')
    } catch {
      toast.error('Failed to upload document')
    } finally {
      setUploading(false)
    }
  }

  return (
    <div className="space-y-4">
      <p className="text-xs text-muted-foreground">
        Upload the first document for the knowledge base (RAG). You can skip and upload it
        later in Knowledge.
      </p>
      <Input
        id={inputId}
        type="file"
        accept=".txt,.pdf,.docx,.md"
        disabled={uploading}
        onChange={(e) => {
          const f = e.target.files?.[0]
          if (f) handleUpload(f)
        }}
      />
      {uploaded && (
        <div className="flex items-center gap-2 text-xs text-success">
          <CheckCircle2 className="h-4 w-4" />
          Document uploaded and indexing.
        </div>
      )}
      <div className="flex gap-2">
        <Button
          variant="outline"
          icon={<ArrowLeft className="h-4 w-4" />}
          onClick={onPrev}
          disabled={uploading}
        >
          Back
        </Button>
        <Button variant="outline" className="flex-1" onClick={onNext}>
          Skip
        </Button>
        {uploaded && (
          <Button className="flex-1" onClick={onNext}>
            Continue →
          </Button>
        )}
      </div>
    </div>
  )
}

/* -------------------------- Step 4: Data Source -------------------------- */

function DataSourceStep({ onNext, onPrev }: { onNext: () => void; onPrev: () => void }) {
  return (
    <div className="space-y-4">
      <p className="text-xs text-muted-foreground">
        Data Sources (SQL databases and REST APIs) can be configured after setup is complete via
        the Data Sources menu. You can connect PostgreSQL, MySQL, or REST endpoints to give the
        assistant read access to your internal data.
      </p>
      <div className="flex gap-2">
        <Button variant="outline" icon={<ArrowLeft className="h-4 w-4" />} onClick={onPrev}>
          Back
        </Button>
        <Button className="flex-1" onClick={onNext}>
          Got it, Continue →
        </Button>
      </div>
    </div>
  )
}

/* ---------------------------- Step 5: Test Chat -------------------------- */

function TestChatStep({ onFinish, onPrev }: { onFinish: () => void; onPrev: () => void }) {
  const [message, setMessage] = useState('')
  const [reply, setReply] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  const [warned, setWarned] = useState(false)

  async function handleSend() {
    if (!message.trim()) return
    setSending(true)
    setReply(null)
    try {
      const createRes = await fetch('/api/chat/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Setup Test' }),
      })
      const session = await createRes.json()
      const sendRes = await fetch(`/api/chat/sessions/${session.id}/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: message }),
      })
      if (!sendRes.ok) throw new Error('Failed')
      const data = await sendRes.json()
      setReply(data?.aiMessage?.content ?? '(empty)')
      setWarned(false)
    } catch {
      setWarned(true)
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="space-y-4">
      <p className="text-xs text-muted-foreground">
        Test a conversation to ensure the LLM responds. You can complete setup even if this test
        fails.
      </p>
      <div className="space-y-2">
        <Label htmlFor="test-msg">Message</Label>
        <Textarea
          id="test-msg"
          placeholder="Hello, connection test."
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          disabled={sending}
        />
      </div>
      <Button
        className="w-full"
        icon={sending ? <Loader2 className="h-4 w-4 animate-spin" /> : undefined}
        onClick={handleSend}
        disabled={sending || !message.trim()}
      >
        Send Test
      </Button>
      {reply && (
        <div className="rounded-md border bg-muted/40 p-3 text-sm">
          <span className="font-medium">Reply: </span>
          {reply}
        </div>
      )}
      {warned && (
        <p className="text-xs text-warning">
          Chat test failed — make sure the LLM configuration is correct. You can still complete setup.
        </p>
      )}
      <div className="flex gap-2">
        <Button
          variant="outline"
          icon={<ArrowLeft className="h-4 w-4" />}
          onClick={onPrev}
          disabled={sending}
        >
          Back
        </Button>
        <Button className="flex-1" variant={warned ? 'destructive' : 'default'} onClick={onFinish}>
          Finish
        </Button>
      </div>
    </div>
  )
}
