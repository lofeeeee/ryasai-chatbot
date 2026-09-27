import { Queue } from 'bullmq'

import { redis } from '@/lib/redis'
import { scopedLogger } from '@/lib/logger'

/**
 * A bounded, retrying queue for memory writes.
 *
 * ─── WHY THIS EXISTS (measured, on the production install) ───
 *
 * Memory writes used to be fired straight at the cognee sidecar from the request path with no
 * throttle. Four simultaneous chats produced EIGHT "already running" rejections and only TWO of the
 * four turns reached memory — because a write holds the sidecar's cognify pipeline for one dataset
 * for 45-148s, and a second write for the SAME dataset during that window is refused.
 *
 * The refusal is the dangerous part: the sidecar answers **HTTP 200** with
 * `{"status":"running","items_processed":0}`. No error, no non-2xx. So the turn looked stored and was
 * not. (The app now detects that response shape and logs it, but detection alone only makes the loss
 * visible.)
 *
 * ─── WHAT THIS CHANGES ───
 *
 * Writes are ENQUEUED and drained by workers with a per-org concurrency of ONE, so a dataset's
 * pipeline is never contended by this process. A refused or failed write is RETRIED with exponential
 * backoff instead of being dropped — the product decision taken here is that a turn the user saw must
 * eventually be remembered.
 *
 * ─── WHY A SEPARATE QUEUE, NOT `document-processing` ───
 *
 * That queue's worker runs with `concurrency: 3`, which is precisely the contention this queue exists
 * to remove, and its jobs are heavy (embedding, cognify) with 300s locks and a stalled-job checker
 * tuned for them. Mixing a 150s memory write into it would make both sets of timings unreadable.
 *
 * ─── FAILURE MODE, STATED PLAINLY ───
 *
 * If Redis is unavailable the write is attempted INLINE, exactly as before this queue existed. Memory
 * is optional; a chat must never fail because a memory queue is down. The inline path is the OLD
 * behaviour, so a Redis outage degrades to what shipped before rather than to something worse.
 */

export interface MemoryWriteJob {
  organizationId: string
  sessionId?: string
  userMessage: string
  aiMessage: string
  toolRuns: Array<{ type: string; status: string; latencyMs: number }>
}

/** One in-flight write per org: the sidecar serialises per DATASET, and a dataset is per org. */
export const MEMORY_WRITE_CONCURRENCY = 1

export const MEMORY_QUEUE_NAME = 'memory-write'

/**
 * Attempts and backoff.
 *
 * 5 attempts over roughly 5 minutes. Chosen against the measured 45-148s write time: a write refused
 * at t=0 becomes acceptable once the pipeline finishes, so the first retry must be LATER than a
 * typical write, not sooner — a 2s retry would simply be refused again and burn an attempt. 30s
 * doubling reaches 8 minutes of total patience, which covers several queued turns draining in order.
 */
export const MEMORY_WRITE_ATTEMPTS = 5
export const MEMORY_WRITE_BACKOFF_MS = 30_000

let _queue: Queue<MemoryWriteJob> | null = null

/**
 * The queue, created lazily.
 *
 * Lazy because `redis.ts` is imported by routes that must not open a connection at module load in a
 * test process, and because a queue handle created before Redis is reachable still works — BullMQ
 * reconnects — but creating one per import is wasteful.
 */
export function memoryWriteQueue(): Queue<MemoryWriteJob> {
  if (_queue) return _queue
  _queue = new Queue<MemoryWriteJob>(MEMORY_QUEUE_NAME, {
    connection: redis,
    defaultJobOptions: {
      attempts: MEMORY_WRITE_ATTEMPTS,
      backoff: { type: 'exponential', delay: MEMORY_WRITE_BACKOFF_MS },
      removeOnComplete: { count: 200 },
      // Kept longer than completions: a failed write is the record an operator needs when a user
      // reports "it forgot what I told it", and a job removed on failure would erase that evidence.
      removeOnFail: { count: 1000 },
      // NOT `true`: a failed memory write must not be silently discarded, which is the whole point.
      // Deliberately absent rather than false, since the option defaults to keeping the job.
    },
  })
  return _queue
}

/** Test seam — mirrors `resetJobWorkerForTest` / `resetEnsuredCollections`. */
export async function resetMemoryQueueForTest(): Promise<void> {
  if (_queue) {
    await _queue.close().catch(() => null)
    _queue = null
  }
}

const log = scopedLogger('memory-queue')

/**
 * Enqueue a memory write, falling back to an inline attempt when Redis is unavailable.
 *
 * The fallback takes the write function as an argument rather than importing it, so this module has no
 * dependency on the cognee transport and can be unit-tested without one.
 */
export async function enqueueMemoryWrite(
  job: MemoryWriteJob,
  inlineFallback: (job: MemoryWriteJob) => Promise<void>,
): Promise<'queued' | 'inline'> {
  /*
   * SKIPPED IN TESTS unless a test opts in.
   *
   * WHY AN EXPLICIT SWITCH AND NOT A HEALTH CHECK. The first version tried the queue and fell back on
   * failure, which made the write path depend on whether REDIS HAPPENED TO BE RUNNING: green in local
   * dev (Redis up), inline in CI (no Redis), and every existing memory test asserted the inline
   * behaviour. A behaviour that differs between environments is one nobody can reason about, and the
   * tests were silently measuring the environment rather than the code.
   *
   * So the queue is OFF under `NODE_ENV=test` by default, and a test that wants it sets
   * `MEMORY_QUEUE_IN_TESTS=1`. The fallback below still covers a REAL Redis outage in production,
   * which is the case it was written for.
   */
  if (process.env.NODE_ENV === 'test' && process.env.MEMORY_QUEUE_IN_TESTS !== '1') {
    await inlineFallback(job)
    return 'inline'
  }

  try {
    await memoryWriteQueue().add('remember-turn', job)
    return 'queued'
  } catch (e) {
    // Redis down, or the queue rejected the job. The chat has already been answered either way, so
    // the only question is whether this write is attempted now or not at all.
    log.warn('queueing the memory write failed; attempting it inline', {
      error: e instanceof Error ? e.message : String(e),
    })
    await inlineFallback(job)
    return 'inline'
  }
}
