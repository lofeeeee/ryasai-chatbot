/**
 * Tamper-evidence hash chain over `AuditLog` rows.
 * ----------------------------------------------------------------------------
 * WHY A CHAIN AND NOT PER-ROW HASHES. `AuditLog` already HAS a `hash` column,
 * written by `writeAudit` (src/lib/session.ts) — but that hash covers only the
 * row's own fields plus a `timestamp: Date.now()` that is never stored
 * anywhere, so it cannot be recomputed from the database, and it cannot detect
 * a DELETE at all: a deleted row leaves no hash behind to disagree with.
 * Chaining each row's hash onto the previous one makes the audit log an
 * append-only claim that survives the row itself being removed — edit or delete
 * ANY row and every hash after it changes, so one stored number (the final
 * chain hash) attests to the whole history.
 *
 * WHY VERIFICATION-ONLY (no schema migration). The chain is re-DERIVED from
 * existing columns on demand; nothing is persisted and no column is added.
 * That is a deliberate release decision, and it is also where the real security
 * boundary sits: an attacker with database write access can recompute a chain
 * as easily as we can, so a `chainHash` column would add a migration and no
 * trust. The anchor that makes this mean anything is the FINAL hash stored OFF
 * the database — an operator's record, a ticket, a backup manifest — which is
 * what scripts/verify-audit-chain.ts compares against. What the scheme catches
 * is uncoordinated tampering: a row deleted from a copy of the database, an
 * "insignificant" old entry edited by hand, a partial restore that missed rows.
 *
 * WHY `breaks` NEEDS A REFERENCE CHAIN. A hash chain re-derived from the rows
 * in front of you always agrees with itself, so "positions that failed
 * re-verification" is only meaningful against a chain recorded by a previous
 * derivation. Comparing position-by-position (not just the final hash) is what
 * makes the report actionable: it names the row id and position where the chain
 * first diverges, and it is the only way to distinguish legitimate GROWTH
 * (appended rows, no break) from TRUNCATION (deleted rows, break).
 */
import { createHash } from 'node:crypto'

/**
 * The shape of one row as it is READ from the database.
 *
 * Deliberately EXCLUDES the existing `hash` column: it is a per-row self-hash
 * seeded with an un-stored `Date.now()` (see writeAudit), so it is not
 * re-derivable, and rows inserted by `tool-branches.ts` / `stream-preparers.ts`
 * carry it NULL. Hashing a column nobody can recompute would make intact rows
 * look tampered.
 */
export interface AuditLogRow {
  id: string
  organizationId: string
  userId?: string | null
  action: string
  severity: string
  detail: string
  ipAddress?: string | null
  createdAt: Date | string | number
}

/** Field order is part of the hash contract; changing it invalidates every stored chain hash. */
const CANONICAL_FIELD_ORDER = [
  'id',
  'organizationId',
  'userId',
  'action',
  'severity',
  'detail',
  'ipAddress',
  'createdAt',
] as const

/** Start of the chain. Same shape as a real hash so `computeChainHash` needs no special case. */
export const GENESIS_HASH = '0'.repeat(64)

/** One link of the derived chain: the running chain hash after absorbing the row at `position`. */
export interface AuditChainPosition {
  position: number
  rowId: string
  chainHash: string
}

/** A position that failed re-verification, shaped for the operator report. */
export interface AuditChainBreak {
  position: number
  /** The row currently at this position, or null when the chain ends before it (row deleted). */
  rowId: string | null
  /** The row the reference chain recorded at this position. */
  referenceRowId: string | null
  reason: 'hash-mismatch' | 'row-missing'
}

export interface AuditChainResult {
  lastHash: string | null
  breaks: number
  /** The full derived chain, so a caller can store it as the next run's reference. */
  positions: AuditChainPosition[]
  breakDetails: AuditChainBreak[]
}

/**
 * The on-disk record `scripts/verify-audit-chain.ts` writes and reads back.
 *
 * Lives here rather than in the script so the FILE FORMAT has one definition.
 * `chain` is the whole per-position chain, not just `lastHash`, because a final
 * hash alone can say THAT something changed but never WHERE — and a report that
 * says only "chain differs" gives an operator nothing to act on.
 */
export interface AuditChainSnapshot {
  organizationId: string
  rowCount: number
  generatedAt: string
  lastHash: string | null
  chain: AuditChainPosition[]
}

/**
 * Canonicalise one field value. `undefined` and absent become null; only JSON
 * scalar shapes are accepted. Anything else (an object, an array, a symbol)
 * throws rather than being hashed as `"[object Object]"` — a hash over a lossy
 * stringification would verify happily on a row whose field had been swapped
 * for a structure, which is precisely the tamper this module exists to catch.
 */
function canonicalValue(field: string, value: unknown): string | number | boolean | null {
  if (value === undefined || value === null) return null
  const t = typeof value
  if (t === 'string' || t === 'number' || t === 'boolean') return value as string | number | boolean
  throw new Error(
    `computeAuditHash: field "${field}" must be a string, number, boolean or null — got ${t}. ` +
      'Canonical JSON here is a flat object; refusing to hash a lossy stringification.',
  )
}

/**
 * Canonicalise `createdAt` to a millisecond integer.
 *
 * Accepts Date, ISO string or epoch millis because the three arrive from three
 * places: Prisma returns Date, a JSON fixture carries a string, a hand-built
 * test row may carry a number. All three must land on the same integer or the
 * same row would hash differently depending on how it was loaded — a chain that
 * "breaks" on intact data is worse than no chain, because it trains the
 * operator to ignore the alarm.
 *
 * `Number.isFinite` (not a truthiness check) is the guard: `new Date(0)` is
 * falsy and epoch zero is a legitimate timestamp.
 */
function canonicalCreatedAt(value: Date | string | number): number {
  const ms = value instanceof Date ? value.getTime() : Number(new Date(value))
  if (!Number.isFinite(ms)) {
    throw new Error(`computeAuditHash: field "createdAt" is not a valid date: ${String(value)}`)
  }
  return ms
}

/** JSON-escape one string. Used per-field, never on the whole row object. */
function jsonString(s: string): string {
  return JSON.stringify(s)
}

/** Encoded form of an already-canonicalised value. */
function encodeCanonicalValue(value: string | number | boolean | null): string {
  if (value === null) return 'null'
  if (typeof value === 'string') return jsonString(value)
  return String(value)
}

/**
 * SHA-256 over a canonical JSON of the row's fields in a FIXED order.
 *
 * The JSON string is BUILT BY HAND, field by field in `CANONICAL_FIELD_ORDER`,
 * rather than `JSON.stringify(row)`: object key insertion order is not part of
 * the type, so the same row loaded from two sources with keys in different
 * orders would stringify differently and the chain would report intact data as
 * tampered. `JSON.stringify` is used only to escape individual strings.
 */
export function computeAuditHash(row: AuditLogRow): string {
  const parts: string[] = []
  for (const field of CANONICAL_FIELD_ORDER) {
    const raw = (row as unknown as Record<string, unknown>)[field]
    const value =
      field === 'createdAt'
        ? canonicalCreatedAt(raw as Date | string | number)
        : canonicalValue(field, raw)
    parts.push(`${jsonString(field)}:${encodeCanonicalValue(value)}`)
  }
  return createHash('sha256').update(`{${parts.join(',')}}`).digest('hex')
}

/** SHA-256 over `${previousHash}:${rowHash}`. The operand order is part of the contract. */
export function computeChainHash(previousHash: string, rowHash: string): string {
  return createHash('sha256').update(`${previousHash}:${rowHash}`).digest('hex')
}

/**
 * Order rows by createdAt then id — the chain's canonical order.
 *
 * Sort is applied HERE rather than trusted from the caller, because the caller
 * getting it wrong must not be able to manufacture or mask a break: a mis-ordered
 * read would otherwise look like mass tampering (every position mismatched), and
 * a caller that re-sorted between two runs would look like none. Sorting on the
 * canonicalised millisecond value, not the raw field, so Date/string/number
 * representations of the same instant tie-break identically.
 */
function inCanonicalOrder(rows: readonly AuditLogRow[]): AuditLogRow[] {
  return [...rows].sort((a, b) => {
    const at = canonicalCreatedAt(a.createdAt)
    const bt = canonicalCreatedAt(b.createdAt)
    if (at !== bt) return at - bt
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  })
}

/**
 * Walk `rows` in canonical order, chaining each row onto the last, and report
 * how many positions fail re-verification against `referenceChain`.
 *
 * `referenceChain` is the `positions` array a previous call returned — the
 * script stores it via `AuditChainSnapshot`. Without it there is nothing to
 * fail against, so `breaks` is 0 by construction; that is why the function is
 * the single code path for BOTH deriving a chain and verifying one: verification
 * is a comparison of two outputs of one implementation, never two
 * implementations agreeing.
 *
 * Break accounting is deliberately ASYMMETRIC, because growth and truncation
 * are not the same event:
 *   - a position where the two chains disagree counts as a break (`hash-mismatch`);
 *   - a reference position the derived chain never reaches counts as a break
 *     (`row-missing`) — trailing rows were deleted, which is tampering;
 *   - a derived position past the end of the reference does NOT count — rows
 *     appended since the last snapshot are normal operation, and counting them
 *     would make every growing audit log read as broken.
 *
 * `async` although the body is synchronous: the contract is awaited by every
 * caller today, so a future implementation that streams rows in pages (an org's
 * whole AuditLog does not fit in memory forever) can land without touching them.
 */
export async function appendAuditChainHashes(
  rows: readonly AuditLogRow[],
  referenceChain?: readonly AuditChainPosition[],
): Promise<AuditChainResult> {
  const ordered = inCanonicalOrder(rows)

  const positions: AuditChainPosition[] = []
  let previousHash = GENESIS_HASH
  for (let i = 0; i < ordered.length; i++) {
    previousHash = computeChainHash(previousHash, computeAuditHash(ordered[i]))
    positions.push({ position: i, rowId: ordered[i].id, chainHash: previousHash })
  }

  const breakDetails: AuditChainBreak[] = []
  if (referenceChain) {
    for (let i = 0; i < referenceChain.length; i++) {
      const reference = referenceChain[i]
      const derived = positions[i]
      if (!derived) {
        breakDetails.push({
          position: i,
          rowId: null,
          referenceRowId: reference.rowId,
          reason: 'row-missing',
        })
        continue
      }
      if (derived.chainHash !== reference.chainHash) {
        breakDetails.push({
          position: i,
          rowId: derived.rowId,
          referenceRowId: reference.rowId,
          reason: 'hash-mismatch',
        })
      }
    }
  }

  return {
    lastHash: positions.length === 0 ? null : positions[positions.length - 1].chainHash,
    breaks: breakDetails.length,
    positions,
    breakDetails,
  }
}
