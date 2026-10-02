/**
 * `audit-chain.ts` — tamper-evidence hash chain over AuditLog.
 * ----------------------------------------------------------------------------
 * Every test below is written so it can FAIL. The chain is pure code that
 * derives its own reference: re-deriving a chain always agrees with itself, so
 * a test that only checks "chain A ≠ chain B after mutation" can pass on a
 * module that hashes nothing but a constant. Two structural defences against
 * that:
 *
 *   1. a GOLDEN VECTOR pins the exact canonical JSON and its SHA-256, computed
 *      here with `node:crypto` rather than by the module under test, so a change
 *      to the field set, the field order or the encoding shows up as a wrong
 *      hash constant — not as a still-self-consistent chain;
 *   2. every mutation test derives its own reference chain FIRST (that is the
 *      "previous run" the script stores) and then mutates, which is the real
 *      threat model: rows change after the operator recorded the chain.
 */
import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import {
  computeAuditHash,
  computeChainHash,
  appendAuditChainHashes,
  GENESIS_HASH,
  type AuditLogRow,
  type AuditChainPosition,
} from './audit-chain'

/** Ordered by createdAt, then id — the chain's canonical order. */
function makeRows(count: number): AuditLogRow[] {
  return Array.from({ length: count }, (_, i): AuditLogRow => {
    const seq = i + 1
    return {
      id: `audit-${String(seq).padStart(3, '0')}`,
      organizationId: 'org-chain',
      userId: seq % 2 === 0 ? `user-${seq}` : null,
      action: `user.action.${seq}`,
      severity: seq % 3 === 0 ? 'warning' : 'info',
      detail: JSON.stringify({ seq, note: `row ${seq}` }),
      ipAddress: seq % 2 === 0 ? `10.0.0.${seq}` : null,
      createdAt: new Date(`2026-01-0${Math.min(seq, 8)}T00:00:0${Math.min(seq - 1, 9)}.000Z`),
    }
  })
}

/** SHA-256 of a string, spelled out so the golden vector is visibly independent of the module. */
function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex')
}

describe('computeAuditHash — canonical form', () => {
  test('matches an independently computed golden vector', () => {
    // Written out field-by-field rather than round-tripping an object through
    // JSON.stringify, because object key order is exactly what must not matter
    // here. This constant is the CONTRACT: the canonical JSON is
    //   {"id":...,"organizationId":...,"userId":...,"action":...,"severity":...,
    //    "detail":...,"ipAddress":...,"createdAt":<epoch millis>}
    const row: AuditLogRow = {
      id: 'audit-1',
      organizationId: 'org-1',
      userId: null,
      action: 'user.login',
      severity: 'info',
      detail: '{"ok":true}',
      ipAddress: '127.0.0.1',
      createdAt: new Date('2026-01-02T03:04:05.678Z'),
    }
    const expectedCanonical =
      '{"id":"audit-1","organizationId":"org-1","userId":null,"action":"user.login",' +
      '"severity":"info","detail":"{\\"ok\\":true}","ipAddress":"127.0.0.1","createdAt":1767323045678}'
    // Guard the fixture itself: if the epoch millis no longer correspond to the
    // ISO string above, the constant under test is meaningless.
    expect(new Date('2026-01-02T03:04:05.678Z').getTime()).toBe(1767323045678)
    expect(sha256(expectedCanonical)).toBe(
      '874980dbec292b0c8192c3ae0737a75fe30c26fe7bbef8e9b2c611e83a1549c0',
    )
    expect(computeAuditHash(row)).toBe(sha256(expectedCanonical))
  })

  test('is deterministic under key-order permutation of the INPUT object', () => {
    const a: AuditLogRow = {
      id: 'audit-9',
      organizationId: 'org-permute',
      userId: 'user-9',
      action: 'document.delete',
      severity: 'critical',
      detail: '{"doc":"d1"}',
      ipAddress: '10.1.2.3',
      createdAt: new Date('2026-02-03T04:05:06.007Z'),
    }
    // Same values, every key in a different order. Built as a separate literal
    // (not Object.keys(a).reverse()) so a reader can see both spellings.
    const b = {
      createdAt: new Date('2026-02-03T04:05:06.007Z'),
      ipAddress: '10.1.2.3',
      detail: '{"doc":"d1"}',
      severity: 'critical',
      action: 'document.delete',
      userId: 'user-9',
      organizationId: 'org-permute',
      id: 'audit-9',
    }
    expect((b as AuditLogRow).id).toBe(a.id)
    expect(computeAuditHash(a)).toBe(computeAuditHash(b as AuditLogRow))
  })

  test('undefined and null optional fields hash identically (undefined coerces to null)', () => {
    const absent: AuditLogRow = {
      id: 'audit-absent',
      organizationId: 'org-null',
      action: 'a',
      severity: 'info',
      detail: '{}',
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
    }
    const explicitNull: AuditLogRow = { ...absent, userId: null, ipAddress: null }
    expect(computeAuditHash(absent)).toBe(computeAuditHash(explicitNull))
  })

  test('createdAt is canonicalised, so Date / ISO string / epoch millis hash identically', () => {
    const date = computeAuditHash({ ...makeRows(1)[0], createdAt: new Date('2026-05-06T07:08:09.123Z') })
    const iso = computeAuditHash({ ...makeRows(1)[0], createdAt: '2026-05-06T07:08:09.123Z' })
    const millis = computeAuditHash({ ...makeRows(1)[0], createdAt: 1778051289123 })
    expect(iso).toBe(date)
    expect(millis).toBe(date)
  })

  test('throws on a non-scalar field rather than hashing a lossy stringification', () => {
    // A hash over String({}) would verify happily after the field was swapped
    // for a structure — the tamper this module exists to catch.
    const row = {
      ...makeRows(1)[0],
      detail: { not: 'a string' },
    } as unknown as AuditLogRow
    expect(() => computeAuditHash(row)).toThrow(/detail/)
  })

  test('throws on an unparseable createdAt rather than hashing NaN', () => {
    const row = { ...makeRows(1)[0], createdAt: 'not a date' } as unknown as AuditLogRow
    expect(() => computeAuditHash(row)).toThrow(/createdAt/)
  })

  test('an absent createdAt throws rather than silently hashing null', () => {
    // The one field with no canonical null: a missing timestamp must be a hard
    // error, not a row that quietly hashes as if it had none.
    const { createdAt: _createdAt, ...row } = makeRows(1)[0]
    expect(() => computeAuditHash(row as AuditLogRow)).toThrow(/createdAt/)
  })
})

describe('computeChainHash', () => {
  test('is SHA-256 over `${previousHash}:${rowHash}`', () => {
    const previousHash = GENESIS_HASH
    const rowHash = computeAuditHash(makeRows(1)[0])
    expect(computeChainHash(previousHash, rowHash)).toBe(sha256(`${previousHash}:${rowHash}`))
  })

  test('is order-sensitive (swapping the operands changes the hash)', () => {
    const a = sha256('a')
    const b = sha256('b')
    expect(computeChainHash(a, b)).not.toBe(computeChainHash(b, a))
  })
})

describe('appendAuditChainHashes — genesis and growth', () => {
  test('empty list: lastHash null, breaks 0', async () => {
    const result = await appendAuditChainHashes([])
    expect(result.lastHash).toBeNull()
    expect(result.breaks).toBe(0)
    expect(result.positions).toEqual([])
    expect(result.breakDetails).toEqual([])
  })

  test('a single row chains onto the genesis hash', async () => {
    const [row] = makeRows(1)
    const result = await appendAuditChainHashes([row])
    const expected = computeChainHash(GENESIS_HASH, computeAuditHash(row))
    expect(result.lastHash).toBe(expected)
    expect(result.positions).toEqual([{ position: 0, rowId: row.id, chainHash: expected }])
  })

  test('appending a row changes only from the new row onward (prefix stability)', async () => {
    const before = await appendAuditChainHashes(makeRows(5))
    const after = await appendAuditChainHashes(makeRows(7))

    // The prefix must be BIT-IDENTICAL, not merely equal in length: an append
    // that perturbed any earlier link would flag untouched history as tampered.
    expect(after.positions.slice(0, 5)).toEqual(before.positions)
    expect(after.lastHash).not.toBe(before.lastHash)
    // And the growth is not a break: appending rows is normal operation.
    expect(after.breaks).toBe(0)
  })

  test('rows are chained in createdAt,id order regardless of input order', async () => {
    const rows = makeRows(4)
    const reversed = await appendAuditChainHashes([...rows].reverse())
    const ordered = await appendAuditChainHashes(rows)
    expect(reversed.lastHash).toBe(ordered.lastHash)
    expect(reversed.positions.map((p) => p.rowId)).toEqual(ordered.positions.map((p) => p.rowId))
  })

  test('ties on createdAt are broken by id, deterministically', async () => {
    const base = makeRows(1)[0]
    const tied = [
      { ...base, id: 'audit-b', createdAt: base.createdAt },
      { ...base, id: 'audit-a', createdAt: base.createdAt },
    ]
    const result = await appendAuditChainHashes(tied)
    expect(result.positions.map((p) => p.rowId)).toEqual(['audit-a', 'audit-b'])
  })
})

describe('appendAuditChainHashes — tamper detection against a reference chain', () => {
  // The reference chain stands in for what scripts/verify-audit-chain.ts stores
  // between runs: derived from the pristine rows, then the rows are mutated.
  const baseline = makeRows(5)

  const mutateAndVerify = async (
    mutation: (rows: AuditLogRow[]) => AuditLogRow[],
  ): Promise<{ previous: Awaited<ReturnType<typeof appendAuditChainHashes>>; after: Awaited<ReturnType<typeof appendAuditChainHashes>> }> => {
    const previous = await appendAuditChainHashes(baseline)
    const after = await appendAuditChainHashes(mutation(baseline), previous.positions)
    return { previous, after }
  }

  test('an unmutated chain re-verifies with zero breaks', async () => {
    // The control: proves the mutation tests below fail for the tamper and not
    // because verification always mismatches. A reference chain must verify
    // clean against the same rows it was derived from.
    const { after } = await mutateAndVerify((rows) => rows)
    expect(after.breaks).toBe(0)
    expect(after.breakDetails).toEqual([])
    expect(after.lastHash).not.toBeNull()
  })

  test('an appended row is growth, not a break', async () => {
    const appended: AuditLogRow = { ...baseline[0], id: 'audit-006', action: 'user.action.6', createdAt: new Date('2026-06-07T00:00:00.000Z') }
    const grown = [...baseline, appended]
    const previous = await appendAuditChainHashes(baseline)
    const after = await appendAuditChainHashes(grown, previous.positions)
    expect(after.breaks).toBe(0)
    expect(after.positions.length).toBe(6)
  })

  test('mutating `action` changes the final hash and increments breaks', async () => {
    const { previous, after } = await mutateAndVerify((rows) =>
      rows.map((r) => (r.id === 'audit-002' ? { ...r, action: 'user.action.elevated' } : r)),
    )
    expect(after.lastHash).not.toBe(previous.lastHash)
    expect(after.breaks).toBe(4)
    // First divergence is the mutated row itself, not a later one.
    expect(after.breakDetails[0]).toEqual({
      position: 1,
      rowId: 'audit-002',
      referenceRowId: 'audit-002',
      reason: 'hash-mismatch',
    })
  })

  test('mutating `detail` changes the final hash and increments breaks', async () => {
    const { previous, after } = await mutateAndVerify((rows) =>
      rows.map((r) =>
        r.id === 'audit-002'
          ? { ...r, detail: JSON.stringify({ seq: 2, note: 'row 2 (edited)' }) }
          : r,
      ),
    )
    expect(after.lastHash).not.toBe(previous.lastHash)
    expect(after.breaks).toBe(4)
    expect(after.breakDetails[0]?.position).toBe(1)
  })

  test('mutating `createdAt` changes the final hash and increments breaks', async () => {
    const { previous, after } = await mutateAndVerify((rows) =>
      rows.map((r) => (r.id === 'audit-002' ? { ...r, createdAt: new Date('2026-03-04T05:06:07.000Z') } : r)),
    )
    expect(after.lastHash).not.toBe(previous.lastHash)
    expect(after.breaks).toBe(4)
    expect(after.breakDetails[0]?.position).toBe(1)
  })

  test('a break does not stop the chain — every position after the tampered row diverges', async () => {
    const { previous, after } = await mutateAndVerify((rows) =>
      rows.map((r) => (r.id === 'audit-001' ? { ...r, severity: 'critical' } : r)),
    )
    expect(after.breaks).toBe(5)
    expect(after.breakDetails.map((b) => b.position)).toEqual([0, 1, 2, 3, 4])
  })

  test('deleting a middle row breaks the chain from that point on', async () => {
    const { previous, after } = await mutateAndVerify((rows) => rows.filter((r) => r.id !== 'audit-003'))
    expect(after.lastHash).not.toBe(previous.lastHash)
    expect(after.breaks).toBe(3)
    // The deleted position is reported as `row-missing`: the reference chain
    // has 5 links, the derived chain 4, and the row at position 4 no longer
    // exists to compare. Positions 2 and 3 are `hash-mismatch` — every row
    // after the deletion chains onto a different predecessor.
    expect(after.breakDetails.map((b) => b.reason)).toEqual([
      'hash-mismatch',
      'hash-mismatch',
      'row-missing',
    ])
    expect(after.breakDetails[0]).toEqual({
      position: 2,
      rowId: 'audit-004',
      referenceRowId: 'audit-003',
      reason: 'hash-mismatch',
    })
    expect(after.breakDetails[2]).toEqual({
      position: 4,
      rowId: null,
      referenceRowId: 'audit-005',
      reason: 'row-missing',
    })
  })

  test('deleting the LAST row is reported as a break, not silently treated as shorter history', async () => {
    // The truncation case the final hash would miss on its own: a chain that
    // simply ends early still shares every derived prefix with the reference,
    // so only the `row-missing` accounting catches it.
    const { previous, after } = await mutateAndVerify((rows) => rows.filter((r) => r.id !== 'audit-005'))
    expect(after.breaks).toBe(1)
    expect(after.breakDetails).toEqual([
      { position: 4, rowId: null, referenceRowId: 'audit-005', reason: 'row-missing' },
    ])
    expect(after.lastHash).toBe(previous.positions[3].chainHash)
  })

  test('a reference chain that is LONGER than the rows reports every missing tail row', async () => {
    const previous = await appendAuditChainHashes(makeRows(5))
    const after = await appendAuditChainHashes(makeRows(2), previous.positions)
    expect(after.breaks).toBe(3)
    expect(after.breakDetails.map((b) => b.reason)).toEqual([
      'row-missing',
      'row-missing',
      'row-missing',
    ])
  })
})
