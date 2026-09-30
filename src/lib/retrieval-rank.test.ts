import { describe, expect, test } from 'bun:test'
import { stampRetrievedRanks } from './retrieval-rank'

describe('retrieval-rank — stampRetrievedRanks', () => {
  test('stamps 1..N in the order the caller receives', () => {
    const chunks = [{ chunkId: 'a' }, { chunkId: 'b' }, { chunkId: 'c' }] as Array<{
      chunkId: string
      rank?: number
    }>
    const returned = stampRetrievedRanks(chunks)
    expect(chunks.map((c) => c.rank)).toEqual([1, 2, 3])
    expect(returned).toBe(chunks)
  })

  test('OVERWRITES a stale rank from an earlier, superseded ordering', () => {
    // The whole reason this exists: `retrieveRelevantChunks` stamps per QUERY, then
    // `retrieveWithReflection` merges up to three expansions and re-selects. The merged order is a
    // new order, so a chunk that arrives carrying rank 3 may belong at position 1. A helper that
    // only filled in MISSING ranks would leave the stale one in place and the badge would keep
    // describing the list that no longer exists.
    const chunks = [
      { chunkId: 'a', rank: 3 },
      { chunkId: 'b', rank: 1 },
      { chunkId: 'c', rank: 2 },
    ]
    stampRetrievedRanks(chunks)
    expect(chunks.map((c) => c.rank)).toEqual([1, 2, 3])
    expect(chunks[0]!.rank).toBe(1)
  })

  test('an empty result stamps nothing and does not throw', () => {
    const chunks: Array<{ chunkId: string; rank?: number }> = []
    expect(stampRetrievedRanks(chunks)).toEqual([])
  })

  test('mutates in place and returns the same array, so a caller can wrap a value it holds', () => {
    // Callers do `chunks: stampRetrievedRanks(selectTopRetrievedChunks(...))`. If this returned a
    // copy, the objects the transports received would still carry the stale ranks and the fix would
    // silently do nothing.
    const chunks = [{ chunkId: 'only' }] as Array<{ chunkId: string; rank?: number }>
    const identity = chunks[0]!
    stampRetrievedRanks(chunks)
    expect(identity.rank).toBe(1)
  })
})
