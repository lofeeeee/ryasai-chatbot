#!/usr/bin/env bun
/**
 * OPT-IN row-level-security enablement for the tenant tables — a defence in depth BENEATH the
 * Prisma tenant extension, not a replacement for it.
 *
 * WHAT IT DOES. For every table in `public` that has an `organizationId` column it enables
 * PostgreSQL RLS, FORCES it (so the table owner is bound by it too), and adds one policy:
 *
 *     CREATE POLICY "<table>_org_isolation" ON "<table>"
 *       USING ("organizationId" = current_setting('app.current_org', true)::text);
 *
 * The table list is READ FROM THE DATABASE (`information_schema.columns`), never hardcoded. That
 * is deliberate and load-bearing: `grep 'organizationId String'` over prisma/schema.prisma finds
 * only the 15 models whose column declaration happens to be aligned that way, out of the 30 that
 * carry the column — the other 15 spell it `organizationId      String` with padding. A hardcoded
 * list built from that grep would have shipped HALF the tenant tables unguarded. The database is
 * the authority; `src/lib/tenant-scope-coverage.test.ts` and `ORG_SCOPED_MODELS` apply to the
 * APPLICATION layer and do not know what a migration left behind.
 *
 * WHY FORCE. `ALTER TABLE ... ENABLE ROW LEVEL SECURITY` alone does not bind the table owner, and
 * the app connects as the owner on a standard on-prem install (DATABASE_URL names the role that
 * `prisma db push` created the tables with). An ENABLE-only RLS that the connecting role can
 * simply ignore is decorative — it reports itself as a control while protecting nothing.
 *
 * THE BLUNT PART — READ IT BEFORE --apply. FORCE binds the app's own role. From that moment every
 * query on those tables is filtered by the `app.current_org` GUC on the connection, and if it is
 * unset, `current_setting('app.current_org', true)` returns NULL, `organizationId = NULL` is not
 * TRUE, and THE QUERY RETURNS ZERO ROWS. Not an error — a silently empty result, which is the
 * worst failure shape this repo has (silent-failure class #14: a dead mechanism that reports
 * itself healthy). The app as shipped does NOT set that GUC; see OUT OF SCOPE below.
 *
 * OUT OF SCOPE, DELIBERATELY. This script does NOT configure the Prisma connection pool to set
 * `app.current_org`. A separate ADR explains why. Anyone expecting this script to make RLS
 * transparent to the app will be disappointed — it is reported here, plainly, in the output.
 *
 * USAGE — report by default, exactly like scripts/cleanup-kg-orphans.ts. It prints what it would
 * run and changes NOTHING until `--apply` is passed:
 *
 *     bun run scripts/enable-rls.ts                # report: list tables, print SQL, exit 0
 *     bun run scripts/enable-rls.ts --apply        # enable RLS + FORCE + create policies
 *     bun run scripts/enable-rls.ts --drop --apply # rollback: drop policies, NO FORCE, disable
 *
 * `--drop` without `--apply` is also report-only. There is no mode that mixes the two.
 */
import { db } from '@/lib/db'

type Mode = 'report' | 'apply' | 'drop'

export function parseArgs(argv: string[]): { mode: Mode; apply: boolean; drop: boolean } {
  const apply = argv.includes('--apply')
  const drop = argv.includes('--drop')
  const mode: Mode = drop ? (apply ? 'drop' : 'report') : apply ? 'apply' : 'report'
  return { mode, apply, drop }
}

/**
 * Parse DATABASE_URL for the username only. The password is never read or printed — the URL
 * is a credential, and an operator-facing report has no reason to carry it.
 */
export function connectingRole(databaseUrl: string): string | null {
  try {
    const u = new URL(databaseUrl)
    return u.username ? decodeURIComponent(u.username) : null
  } catch {
    return null
  }
}

/**
 * Which of the tenant tables does the connecting role OWN? The answer decides how dangerous
 * FORCE is: FORCE is the clause that binds the OWNER, so an install where DATABASE_URL names
 * the role that `prisma db push` created the tables with gets its app bound by the policy.
 * Read from the catalog rather than assumed — an install provisioned with a separate owner
 * role is the case where FORCE is cheap, and conflating the two is how the warning gets
 * ignored.
 */
export async function ownedTables(tables: string[]): Promise<string[]> {
  if (tables.length === 0) return []
  /*
   * Two corrections, both MEASURED against a live Postgres 16 after an integration review caught the
   * first version crashing in report mode:
   *
   * 1. `IN (${tables})` did not work: Prisma's `$queryRaw` binds a JS array as ONE `text[]` parameter
   *    rather than expanding it into a list, so Postgres raised `42883: operator does not exist:
   *    information_schema.sql_identifier = text[]`. `= ANY(${tables}::text[])` is the form that binds.
   * 2. `information_schema.tables` has NO `table_owner` column at all — the real column set was
   *    enumerated live and ownership is not among it. It lives in `pg_catalog`: pg_class.relowner
   *    joined to pg_roles. The first query failed with `42703: column "table_owner" does not exist`
   *    on the database this script exists to serve, which is worth recording because the unit test
   *    modelled a catalog WITH that column — a fantasy catalog that could never fail the query
   *    (silent-failure class 20: the test measured the mock, not the database).
   */
  const rows = await db.$queryRaw<Array<{ table_name: string }>>`
    SELECT c.relname AS table_name
    FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_roles r ON r.oid = c.relowner
    WHERE c.relnamespace = 'public'::regnamespace
      AND c.relkind = 'r'
      AND c.relname = ANY(${tables}::text[])
      AND r.rolname = current_user
  `
  return rows.map((row) => row.table_name)
}

function banner(mode: Mode): void {
  const label = mode === 'drop' ? 'DROP (rollback)' : mode === 'apply' ? 'APPLY' : 'REPORT'
  console.log('════════════════════════════════════════════════════════════════════════════')
  console.log(`  enable-rls — PostgreSQL row-level security for tenant tables  [${label}]`)
  console.log('════════════════════════════════════════════════════════════════════════════')
}

/**
 * Discover the tenant tables from the live database. `DISTINCT` because information_schema
 * reports one row per column, and a table carrying organizationId twice is a schema bug the
 * operator needs to see, not something this script should paper over by deduplicating silently.
 */
export async function discoverTenantTables(): Promise<string[]> {
  const rows = await db.$queryRaw<Array<{ table_name: string }>>`
    SELECT DISTINCT table_name
    FROM information_schema.columns
    WHERE table_schema = 'public' AND column_name = 'organizationId'
    ORDER BY table_name
  `
  return rows.map((r) => r.table_name)
}

export function enableStatements(table: string): string[] {
  return [
    `ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY;`,
    `ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY;`,
    `CREATE POLICY "${table}_org_isolation" ON "${table}" USING ("organizationId" = current_setting('app.current_org', true)::text);`,
  ]
}

export function dropStatements(table: string): string[] {
  return [
    `DROP POLICY IF EXISTS "${table}_org_isolation" ON "${table}";`,
    `ALTER TABLE "${table}" NO FORCE ROW LEVEL SECURITY;`,
    `ALTER TABLE "${table}" DISABLE ROW LEVEL SECURITY;`,
  ]
}

/**
 * THE SAFETY CHECK (requirement 2c). Before FORCE we read back what role the script is
 * connected as AND which of the tenant tables that role owns, then warn in the operator's
 * face that FORCE binds the owner. The warning prints in REPORT mode too, so it is read
 * BEFORE --apply is ever run.
 */
function printOwnerWarning(role: string | null, owned: string[], tableCount: number): void {
  console.log('')
  console.log('┌────────────────────────────────────────────────────────────────────────────┐')
  console.log('│ ⚠  READ THIS BEFORE --apply: FORCE binds the role you connect as          │')
  console.log('├────────────────────────────────────────────────────────────────────────────┤')
  console.log(`│ Connecting role (from DATABASE_URL): ${role ?? 'UNKNOWN (DATABASE_URL unparseable)'}`)
  console.log(`│ Tables owned by that role:            ${owned.length}/${tableCount}`)
  if (owned.length === tableCount) {
    console.log('')
    console.log('  The connecting role owns EVERY tenant table — the usual on-prem shape, where')
    console.log('  DATABASE_URL names the role `prisma db push` created the tables with. This is')
    console.log('  exactly the case FORCE exists for: without it, the owner would simply ignore')
    console.log('  RLS and the control would be decorative.')
  } else if (owned.length > 0) {
    console.log('')
    console.log('  The connecting role owns SOME tenant tables. Those are bound by FORCE; the')
    console.log('  rest are not, and their isolation still depends on the app alone.')
  } else {
    console.log('')
    console.log('  The connecting role owns NONE of the tenant tables. FORCE still applies the')
    console.log('  policy to non-owner roles, but the owner is not this connection — an')
    console.log('  unscoped connection made as that owner would still see every row.')
  }
  console.log('')
  console.log('  Once FORCED, the app MUST set app.current_org on every connection or every')
  console.log('  query on these tables returns ZERO ROWS — silently, with no error. Verify')
  console.log('  the GUC is set in your pool config by running this SQL:')
  console.log('')
  console.log("    SELECT current_user, current_setting('app.current_org', true) AS org;")
  console.log('')
  console.log('  If org is NULL on a connection that queries these tables, that connection')
  console.log('  is returning empty results and should be treated as misconfigured.')
  console.log('└────────────────────────────────────────────────────────────────────────────┘')
}

function printOutOfScope(): void {
  console.log('')
  console.log('OUT OF SCOPE (deliberate): this script does NOT configure the Prisma')
  console.log('connection pool to set `app.current_org`. A separate ADR explains why.')
  console.log('Enabling RLS here is a floor for the tables, not a transparent switch for')
  console.log('the application — the app must set the GUC itself, or it sees zero rows.')
}

/**
 * `main` is exported (and takes argv explicitly) so the test can drive REPORT, APPLY and DROP
 * end-to-end against the mocked db, the same way `cleanup-kg-orphans.ts` behaviour is pinned.
 * The `import.meta.main` guard below keeps it from running when imported under `bun test`.
 */
export async function main(argv: string[] = []): Promise<void> {
  const { mode, apply, drop } = parseArgs(argv)

  banner(mode)

  const tables = await discoverTenantTables()

  if (tables.length === 0) {
    console.log('')
    console.log('No tables with an organizationId column found in schema public.')
    console.log('Nothing to do.')
    return
  }

  console.log('')
  console.log(`Tenant tables (${tables.length}) carrying organizationId:`)
  for (const t of tables) console.log(`  - ${t}`)

  const role = connectingRole(process.env.DATABASE_URL ?? '')
  const owned = await ownedTables(tables)
  printOwnerWarning(role, owned, tables.length)
  printOutOfScope()

  const statements = tables.flatMap((t) => (drop ? dropStatements(t) : enableStatements(t)))

  console.log('')
  console.log(drop ? 'Statements that WOULD run (--drop --apply):' : 'Statements that WOULD run (--apply):')
  for (const s of statements) console.log(`  ${s}`)

  if (!apply) {
    console.log('')
    if (drop) {
      console.log('Report only. Re-run with --drop --apply to remove the policies and disable RLS.')
    } else {
      console.log('Report only. Re-run with --apply to enable RLS and create the policies.')
    }
    return
  }

  console.log('')
  console.log(drop ? 'Dropping policies and disabling RLS…' : 'Enabling RLS and creating policies…')
  for (const s of statements) {
    await db.$executeRawUnsafe(s)
    console.log(`  ok: ${s}`)
  }
  console.log('')
  console.log(
    drop
      ? `Done: policies dropped and RLS disabled on ${tables.length} table(s).`
      : `Done: RLS enabled and FORCED on ${tables.length} table(s); policy "<table>_org_isolation" created on each.`,
  )
  if (!drop) {
    console.log(`  FORCED — the owner role is now bound by the "${tables[0]}_org_isolation" shape of`)
    console.log('  policy on every table above, and each connection that does not set')
    console.log('  app.current_org sees ZERO ROWS on these tables.')
  }
}

if (import.meta.main) {
  main(process.argv.slice(2))
    .then(() => process.exit(0))
    .catch((e) => {
      console.error(e)
      process.exit(1)
    })
}
