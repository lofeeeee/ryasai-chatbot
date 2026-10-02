#!/usr/bin/env bun
/**
 * Verify an organization's `AuditLog` tamper-evidence hash chain.
 * ----------------------------------------------------------------------------
 * WHAT THIS PROTECTS AGAINST. The audit log is the record a security incident
 * is investigated from, but nothing in the schema stops a row being edited or
 * deleted after the fact. `src/lib/audit-chain.ts` chains each row's hash onto
 * the previous one, so ANY edit or deletion changes every hash after it — which
 * means one number recorded outside the database attests to the whole history.
 *
 * WHY THIS IS A SCRIPT AND NOT A PERSISTED COLUMN. The chain is re-derived from
 * existing columns on demand; no schema migration and no new column. That is
 * deliberate: an attacker with database write access can recompute a chain as
 * easily as we can, so a `chainHash` column would add a migration and no trust.
 * The anchor is the hash the OPERATOR stores outside the database — a ticket, a
 * change record, a backup manifest. This script derives, compares, and reports.
 *
 * USAGE
 *
 *   bun run scripts/verify-audit-chain.ts <organizationId>                  # derive + print
 *   bun run scripts/verify-audit-chain.ts <organizationId> --save chain.json
 *   bun run scripts/verify-audit-chain.ts <organizationId> --from-file chain.json
 *   bun run scripts/verify-audit-chain.ts <organizationId> --expect <hash>
 *
 * The first form prints the final chain hash with instructions to store it.
 * Later runs pass it back via `--expect`, or the whole snapshot via `--from-file`.
 * `--from-file` is the better of the two: a bare hash can only say THAT
 * something changed, while a snapshot names the row and position where the
 * chain first diverges.
 *
 * EXIT CODES. 0 = chain stable (or a baseline run with nothing to compare
 * against). 1 = a break was found, the expected hash did not match, or the
 * arguments were wrong. A missing organization is exit 1, not a silent empty
 * chain — a typo'd id must not read as "verified, nothing happened".
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { db } from '@/lib/db'
import { bypassOrg } from '@/lib/prisma-tenant'
import {
  appendAuditChainHashes,
  type AuditChainSnapshot,
  type AuditLogRow,
} from '@/lib/audit-chain'

const USAGE = `Usage:
  bun run scripts/verify-audit-chain.ts <organizationId> [--save <file>]
  bun run scripts/verify-audit-chain.ts <organizationId> (--from-file <file> | --expect <hash>)

Options:
  --expect <hash>   Final chain hash recorded from a previous run.
  --from-file <file> Snapshot written by --save (full per-position chain).
  --save <file>     Write the snapshot JSON for a later --from-file run.
  --help            Show this message.`

/** Accepts both `--flag value` and `--flag=value` (both spellings exist in scripts/). */
function flagValue(name: string): string | undefined {
  const argv = process.argv
  const spaced = argv.indexOf(`--${name}`)
  if (spaced !== -1 && spaced + 1 < argv.length) return argv[spaced + 1]
  return argv.find((a) => a.startsWith(`--${name}=`))?.slice(`--${name}=`.length)
}

/** The flags that consume the argument after them, so it is not mistaken for an org id. */
const FLAGS_WITH_VALUES = ['expect', 'from-file', 'save'] as const

function fail(message: string): never {
  console.error(`verify-audit-chain: ${message}`)
  console.error(USAGE)
  process.exit(1)
}

/** Minimal shape check — a malformed snapshot must fail loudly, not verify as "stable". */
function readSnapshot(path: string): AuditChainSnapshot {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch (e) {
    fail(`could not read snapshot ${path}: ${(e as Error).message}`)
  }
  const s = parsed as AuditChainSnapshot
  if (
    !s ||
    typeof s.organizationId !== 'string' ||
    typeof s.rowCount !== 'number' ||
    typeof s.generatedAt !== 'string' ||
    !Array.isArray(s.chain) ||
    !s.chain.every((p) => typeof p?.position === 'number' && typeof p?.rowId === 'string' && typeof p?.chainHash === 'string')
  ) {
    fail(`${path} is not a chain snapshot written by --save`)
  }
  return s
}

async function main(): Promise<void> {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    console.log(USAGE)
    return
  }

  // Values of the flags above are consumed here so they are not counted as positional
  // arguments — `--save chain.json` must not read as a second organization id.
  const consumed = new Set<string>()
  for (const name of FLAGS_WITH_VALUES) {
    const i = process.argv.indexOf(`--${name}`)
    if (i !== -1 && i + 1 < process.argv.length) consumed.add(process.argv[i + 1])
  }
  const positional = process.argv.slice(2).filter((a) => !a.startsWith('--') && !consumed.has(a))
  if (positional.length !== 1) fail('exactly one organization id is required')
  const organizationId = positional[0]

  const expect = flagValue('expect')
  const fromFile = flagValue('from-file')
  const save = flagValue('save')
  if (expect && fromFile) fail('--expect and --from-file are alternatives; pass one')

  const snapshot = fromFile ? readSnapshot(fromFile) : undefined
  if (snapshot && snapshot.organizationId !== organizationId) {
    fail(
      `snapshot is for organization ${snapshot.organizationId}, but ${organizationId} was requested — ` +
        'a chain only verifies against the rows it was derived from',
    )
  }
  if (expect !== undefined && !/^[0-9a-f]{64}$/.test(expect)) {
    fail(`--expect must be a 64-character hex hash, got "${expect}"`)
  }

  // `bypassOrg` because this runs outside request context: there is no org in
  // AsyncLocalStorage for a script, and the organizationId is supplied explicitly
  // below rather than left to the tenant extension to guess.
  const { rows, orgExists } = await bypassOrg(async () => {
    const org = await db.organization.findUnique({ where: { id: organizationId }, select: { id: true } })
    if (!org) return { rows: [] as AuditLogRow[], orgExists: false }
    // Only the hashed fields are selected, so the query documents exactly what
    // the chain covers. Ordering matches the chain's canonical order
    // (createdAt, then id) — appendAuditChainHashes re-sorts defensively, but
    // the read and the derivation must agree for the positions to line up.
    const loaded = await db.auditLog.findMany({
      where: { organizationId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: {
        id: true,
        organizationId: true,
        userId: true,
        action: true,
        severity: true,
        detail: true,
        ipAddress: true,
        createdAt: true,
      },
    })
    return { rows: loaded as AuditLogRow[], orgExists: true }
  })

  if (!orgExists) fail(`no organization with id "${organizationId}" — nothing was verified`)

  const result = await appendAuditChainHashes(rows, snapshot?.chain)
  console.log(`organization       : ${organizationId}`)
  console.log(`audit rows         : ${rows.length}`)
  console.log(`final chain hash   : ${result.lastHash ?? '(no rows — empty audit log)'}`)
  if (snapshot) {
    console.log(`snapshot rows      : ${snapshot.rowCount} (generated ${snapshot.generatedAt})`)
  }

  // ---- Reporting ----------------------------------------------------------
  // A break is a position where the re-derived chain disagrees with the stored
  // one. Every position from the first divergence onward is reported, because
  // that is what a hash chain guarantees: one tampered row invalidates the rest.
  if (result.breaks > 0) {
    console.log(`\nCHAIN BREAKS: ${result.breaks}`)
    for (const b of result.breakDetails) {
      if (b.reason === 'row-missing') {
        console.log(
          `  position ${b.position}: row MISSING (reference recorded "${b.referenceRowId}") — ` +
            'rows were deleted from the end of the log',
        )
      } else {
        console.log(
          `  position ${b.position}: hash mismatch (row "${b.rowId}", reference recorded "${b.referenceRowId}") — ` +
            'this row, or one before it, was edited or deleted',
        )
      }
    }
  }

  if (snapshot) {
    const appended = result.positions.length - snapshot.chain.length
    if (result.breaks === 0 && appended > 0) {
      // Not a tamper finding, but still exit 1: the recorded hash no longer
      // describes the log, so an operator who ignores the exit code and keeps
      // the old record would falsely "verify" the next run against a stale
      // anchor. The message says which action to take.
      console.log(
        `\nHistory INTACT, hash STALE: all ${snapshot.chain.length} recorded positions re-verified ` +
          `and ${appended} row(s) appended since the snapshot. Append-only growth is not tampering, ` +
          'but the recorded final hash no longer describes this log — re-baseline with --save.',
      )
    } else if (result.breaks === 0 && snapshot.lastHash && result.lastHash === snapshot.lastHash) {
      console.log(`\nChain STABLE: all ${snapshot.chain.length} recorded positions re-verified.`)
    }
  } else if (expect) {
    if (result.lastHash === expect) {
      console.log('\nChain STABLE: final hash matches the recorded value.')
    } else {
      console.log(`\nEXPECTED HASH DID NOT MATCH.\n  expected: ${expect}\n  derived : ${result.lastHash ?? '(none)'}`)
      console.log(
        '  A bare hash cannot say WHERE the chain diverged. Re-run with --from-file against a ' +
          'snapshot to get per-row positions, then compare the row at the first break against ' +
          'your records.',
      )
    }
  }

  if (save) {
    const toWrite: AuditChainSnapshot = {
      organizationId,
      rowCount: rows.length,
      generatedAt: new Date().toISOString(),
      lastHash: result.lastHash,
      chain: result.positions,
    }
    writeFileSync(save, JSON.stringify(toWrite, null, 2) + '\n')
    console.log(`\nsnapshot written   : ${save}`)
  }

  // ---- Exit decision ------------------------------------------------------
  if (result.breaks > 0) {
    console.log('\nFAILED: the audit chain has breaks. Treat the log as tampered until explained.')
    process.exit(1)
  }
  if (expect !== undefined && result.lastHash !== expect) {
    process.exit(1)
  }
  if (snapshot && result.lastHash !== snapshot.lastHash) {
    /*
     * Covers pure growth too, on purpose: the recorded hash no longer describes the log, so the operator
     * must re-baseline before it can be relied on.
     *
     * The `snapshot.lastHash &&` guard that used to be here was a MEASURED defect (caught in review): a
     * baseline saved on an EMPTY log stores lastHash null, so the guard short-circuited and the very first
     * audit row after the baseline made this branch unreachable — the script printed "STALE" and exited 0,
     * and anything reading only the exit code (a cron wrapper, CI) read "verified". A null-to-non-null
     * transition is growth and must trip the same re-baseline path as any other change.
     */
    process.exit(1)
  }

  if (!expect && !snapshot) {
    console.log(
      '\nNo expectation was supplied, so nothing was compared. STORE THE FINAL CHAIN HASH above' +
        ' somewhere the database cannot reach (a ticket, a change record, a backup manifest), then' +
        ' pass it back with --expect <hash> — or re-run with --save <file> to keep the full' +
        ' per-position snapshot, which reports WHERE a break is rather than only THAT one occurred.',
    )
  }
}

main()
  .then(() => db.$disconnect().then(() => process.exit(process.exitCode || 0)))
  .catch(async (e) => {
    console.error(e)
    await db.$disconnect().catch(() => {})
    process.exit(1)
  })
