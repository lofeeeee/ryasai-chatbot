/**
 * Delete `KgRelation` rows whose `chunkId` no longer exists.
 *
 * WHY THIS IS A SCRIPT AND NOT A CONSTRAINT
 * ----------------------------------------------------------------------------
 * `KgRelation.chunkId` should be a foreign key, and it is not, for a measured reason: `prisma db push` runs in the
 * `migrate` service on EVERY boot, BEFORE the application starts, so no runtime cleanup can run ahead of it. Adding
 * the constraint makes that push VALIDATE existing rows and refuse — MEASURED on a clone of a real database holding
 * 131 orphans:
 *
 *     Error: insert or update on table "KgRelation" violates foreign key constraint "KgRelation_chunkId_fkey"
 *
 * and the migrate container exits non-zero, so the app never starts. That is a failed install, which is worse than
 * orphaned rows.
 *
 * WHERE THE ORPHANS CAME FROM (fixed at the source in the same change): `restoreVersion` deleted a document's
 * chunks and re-inserted them, without touching the relation rows that named the old ids. Any install that has
 * restored a document version may hold some.
 *
 * USAGE — read-only by default. It prints what it would delete and changes nothing until `--apply` is passed:
 *
 *     bun run scripts/cleanup-kg-orphans.ts            # report
 *     bun run scripts/cleanup-kg-orphans.ts --apply    # delete
 *
 * After it reports zero, a later release can add the constraint.
 */
import { db } from '@/lib/db'
import { bypassOrg } from '@/lib/prisma-tenant'

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply')

  // `bypassOrg` because this is a cross-org maintenance task: the tenant extension would otherwise scope the query to
  // whichever org the caller happens to be in, and the orphans of every OTHER org would be reported as zero — a
  // cleanup that reports success having done nothing.
  const result = await bypassOrg(async () => {
    const total = await db.kgRelation.count()
    const orphanRows = await db.$queryRaw<Array<{ id: string; chunkId: string; organizationId: string }>>`
      SELECT r.id, r."chunkId", r."organizationId"
      FROM "KgRelation" r
      LEFT JOIN "DocumentChunk" c ON c.id = r."chunkId"
      WHERE c.id IS NULL
      LIMIT 1000
    `
    if (!apply || orphanRows.length === 0) return { total, orphanRows, deleted: 0 }
    const deleted = await db.kgRelation.deleteMany({ where: { id: { in: orphanRows.map((r) => r.id) } } })
    return { total, orphanRows, deleted: deleted.count }
  })

  console.log(`KgRelation rows: ${result.total}`)
  console.log(`Orphaned (chunkId matches no DocumentChunk): ${result.orphanRows.length}${result.orphanRows.length === 1000 ? '+' : ''}`)
  for (const row of result.orphanRows.slice(0, 5)) {
    console.log(`  org=${row.organizationId} chunkId=${row.chunkId}`)
  }
  if (result.orphanRows.length > 5) console.log(`  … and ${result.orphanRows.length - 5} more`)

  if (!apply) {
    console.log('\nReport only. Re-run with --apply to delete them.')
    return
  }
  console.log(`\nDeleted ${result.deleted} orphaned row(s).`)
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
