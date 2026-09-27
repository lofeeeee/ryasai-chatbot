import { Worker, type Job } from 'bullmq'

import { redis } from '@/lib/redis'
import { enterWithOrg } from '@/lib/prisma-tenant'
import { scopedLogger } from '@/lib/logger'
import {
  MEMORY_QUEUE_NAME,
  MEMORY_WRITE_CONCURRENCY,
  type MemoryWriteJob,
} from '@/lib/memory-queue'

/**
 * The memory-write worker.
 *
 * Runs in the app process by default (started from `instrumentation.ts` beside the document worker).
 * The scheduler process does NOT start it — see the note at the bottom.
 *
 * ─── CONCURRENCY 1, AND WHY THAT IS THE FEATURE ───
 *
 * The sidecar serialises writes per DATASET, and a dataset is per org. So a second write for the same
 * org arriving mid-pipeline is REFUSED — with HTTP 200 and `items_processed: 0`, which reads as
 * success. Running one write at a time per org turns a silent loss into an orderly queue: the next
 * turn waits its turn instead of being discarded.
 *
 * Cross-org writes could run in parallel, and `concurrency: 1` gives that up. That is a deliberate
 * choice for now: the measured problem is per-org contention, the volume is a single install's chat
 * traffic, and a global 1 makes the queue's behaviour trivially explainable. Grouping by org with a
 * per-org key would be the next step if throughput ever matters.
 */

const log = scopedLogger('memory-worker')

let _worker: Worker<MemoryWriteJob> | null = null

/** Test seam, mirroring `resetJobWorkerForTest`. */
export function resetMemoryWorkerForTest(): void {
  _worker = null
}

/**
 * Perform one memory write.
 *
 * Exported so the retry/throwing behaviour is testable without a live worker, and so the inline
 * fallback in `enqueueMemoryWrite` can call the SAME code path — two implementations of "write this
 * turn" would drift.
 *
 * THROWS on a write that did not store anything, which is what makes BullMQ retry it. Returning
 * normally on a refused write is exactly the false success this queue exists to remove.
 */
export async function performMemoryWrite(jobData: MemoryWriteJob): Promise<void> {
  const { getCogneeServerOptions } = await import('@/lib/cognee-core')
  const { cogneeRemember } = await import('@/lib/cognee-http')
  const { datasetFor } = await import('@/lib/cognee-types')
  const { MEMORY_WRITE_MAX_CHARS } = await import('@/lib/constants')

  const opts = await getCogneeServerOptions()
  if (!opts) {
    // Memory is off for this deployment. NOT an error and NOT retryable — retrying would burn five
    // attempts on a condition that will not change. Returning quietly also keeps this worker safe to
    // run on an install that has memory disabled.
    log.debug('memory write skipped: no cognee server configured')
    return
  }

  const text = JSON.stringify({
    type: 'chat_turn',
    user: jobData.userMessage,
    assistant: jobData.aiMessage,
    tools: jobData.toolRuns,
    sessionId: jobData.sessionId,
    ts: Date.now(),
  }).slice(0, MEMORY_WRITE_MAX_CHARS)

  const res = await cogneeRemember(opts, {
    texts: [text],
    datasetName: datasetFor(),
    runInBackground: false,
  })

  if (!res) {
    // Transport failure — transient by nature, so RETRY.
    throw new Error('cognee server unreachable or rejected the write')
  }
  if (res.error) {
    throw new Error(`cognee rejected the write: ${res.error}`)
  }
  if (res.status === 'running' || res.items_processed === 0) {
    /*
     * THE CONCURRENTLY-REFUSED CASE, and the reason this worker retries rather than ignores.
     *
     * MEASURED: the sidecar answers HTTP 200 with `{"status":"running","items_processed":0}` while a
     * dataset's pipeline is busy. Nothing was stored. Throwing here converts that into a BullMQ retry
     * with exponential backoff, so the turn is written once the pipeline frees up instead of being
     * dropped — the decision taken for this product.
     *
     * `rememberChatTurn` keeps its own detection for the inline path; this duplication is deliberate.
     * The queue path must not depend on a function whose contract is "never throws" (it is
     * fire-and-forget at its call sites), or every retry here would be invisible.
     */
    throw new Error(
      `memory write not stored (status=${res.status ?? 'n/a'}, items_processed=${res.items_processed ?? 'n/a'}) — retrying`,
    )
  }
}

/**
 * Start the worker once per process.
 *
 * Org context: BullMQ runs outside the request's AsyncLocalStorage, so `datasetFor()` — which reads
 * `getOrgContext()` — would resolve to the WRONG dataset (or none) without entering the job's org.
 * The org travels IN the job payload, so no DB lookup is needed; only the context has to be entered.
 */
export function startMemoryWorker(): Worker<MemoryWriteJob> {
  if (_worker) return _worker
  _worker = new Worker<MemoryWriteJob>(
    MEMORY_QUEUE_NAME,
    async (job: Job<MemoryWriteJob>) => {
      // The job carries its org, so no DB lookup is needed — but the CONTEXT still has to be entered,
      // because `datasetFor()` reads it from AsyncLocalStorage rather than from an argument. Getting
      // this wrong writes another tenant's turn into this dataset, which is the cross-tenant failure
      // this module must not introduce.
      enterWithOrg(job.data.organizationId)
      await performMemoryWrite(job.data)
    },
    {
      connection: redis,
      concurrency: MEMORY_WRITE_CONCURRENCY,
      // A write measures 45-148s. The default 30s lock would expire mid-write and hand the same job to
      // a second worker — which the sidecar would then REFUSE as already-running, defeating the retry.
      lockDuration: 300_000,
      stalledInterval: 60_000,
      maxStalledCount: 2,
    },
  )
  _worker.on('failed', (job, err) => {
    // Logged at warn with the attempt count: a memory write that exhausts its retries is a real,
    // reportable loss ("it forgot what I told it"), not routine noise.
    log.warn('memory write failed', {
      attemptsMade: job?.attemptsMade,
      maxAttempts: job?.opts.attempts,
      error: err.message,
    })
  })
  _worker.on('completed', (job) => {
    log.debug('memory write stored', { attemptsMade: job.attemptsMade })
  })
  return _worker
}
