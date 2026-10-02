/**
 * enable-rls — the report/apply/drop contract.
 *
 * WHY THIS FILE EXISTS. This script flips a database-wide isolation control that, once FORCED,
 * makes the app's own queries return zero rows if a connection GUC is missing. A silent
 * mis-step here is the worst failure shape this repo has (silent-failure class #14: a mechanism
 * that reports itself healthy while doing nothing) — so the DANGEROUS direction is pinned as
 * hard as the safe one:
 *
 *   - REPORT mode must issue NO DDL at all. The whole point of the default is that an operator
 *     can run it blind, on production, to see what would happen. Asserted by requiring the
 *     captured statement list to be EMPTY, not merely "no ENABLE" — a partial assertion here
 *     would let some other statement slip through unreviewed.
 *   - APPLY mode must issue exactly one ENABLE, one FORCE and one CREATE POLICY per discovered
 *     table. Counted per table, because a script that enables RLS on a table but forgets its
 *     policy leaves that table with RLS on and NO policy — which in Postgres means the table
 *     returns zero rows for everyone. That is worse than no RLS at all.
 *   - The table list must come from information_schema, and a table WITHOUT organizationId
 *     must not be touched. The schema grep that a hardcoded list would come from misses half
 *     the tenant tables (aligned vs unaligned column declarations), which is exactly why the
 *     discovery query is the contract.
 *   - --drop must remove the policy AND lift the FORCE clause. Dropping the policy without
 *     NO FORCE would leave the owner bound by a policy that no longer exists.
 *
 * THE MOCK MODELS THE CATALOG, NOT THE ANSWER. `$queryRaw` does not return a canned table list;
 * it holds a miniature `information_schema.columns` and applies the predicates it finds in the
 * SQL the script sends. That is what makes the decoy assertions able to FAIL: if the script's
 * discovery query dropped its `column_name = 'organizationId'` predicate, the mock would return
 * every table in the fixture — decoys included — and the "not touched" assertions would go red.
 * A mock that returned only the tenant tables would make those assertions vacuous, and a
 * hardcoded table list in the script would pass them.
 *
 * Mock shape follows `src/lib/knowledge-graph.test.ts`: mock.module('@/lib/db', …) BEFORE
 * importing the script, capturing both the tagged-template discovery query and every
 * `$executeRawUnsafe` DDL statement. NO DATABASE IS TOUCHED — `$executeRawUnsafe` records and
 * returns, and the script's `import.meta.main` guard keeps the CLI entry from running on import.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test'

// ---- captured seams, declared ABOVE every mock.module ----
let queryRawCalls: Array<{ strings: string[]; values: unknown[] }> = []
let ddlStatements: string[] = []

/** A miniature information_schema.columns, as Postgres would report it. */
let schemaColumns: Array<{ table_schema: string; table_name: string; column_name: string }> = []

/**
 * A miniature information_schema.tables, for the ownership check. `table_owner` is what
 * decides how dangerous FORCE is, and it is deliberately MUTABLE: "owns all / some / none"
 * are three different facts about an install, and a fixture that could only produce one of
 * them would leave the other two warning branches untested.
 */
let schemaTables: Array<{ table_schema: string; table_name: string; table_owner: string }> = []

/** The role `current_user` resolves to inside the mock. */
let currentUser = 'app_owner'

/**
 * The fixture. Three genuine tenant tables, plus two decoys:
 *   - `Organization` has NO organizationId column (it is the org root), so a correct
 *     discovery query never returns it.
 *   - `OutOfScopeSchema` HAS organizationId but lives in a non-public schema, so the
 *     `table_schema = 'public'` predicate must exclude it.
 */
function seedCatalog(): void {
  schemaColumns = [
    { table_schema: 'public', table_name: 'ChatSession', column_name: 'organizationId' },
    { table_schema: 'public', table_name: 'ChatSession', column_name: 'id' },
    { table_schema: 'public', table_name: 'DocumentChunk', column_name: 'organizationId' },
    { table_schema: 'public', table_name: 'DocumentChunk', column_name: 'content' },
    { table_schema: 'public', table_name: 'User', column_name: 'organizationId' },
    { table_schema: 'public', table_name: 'User', column_name: 'email' },
    // decoy 1: no organizationId column at all
    { table_schema: 'public', table_name: 'Organization', column_name: 'id' },
    { table_schema: 'public', table_name: 'Organization', column_name: 'name' },
    // decoy 2: the right column, wrong schema
    { table_schema: 'cognee', table_name: 'OutOfScopeSchema', column_name: 'organizationId' },
  ]
  // Default: the connecting role owns every tenant table — the usual on-prem shape, where
  // DATABASE_URL names the role `prisma db push` created the tables with.
  schemaTables = ['ChatSession', 'DocumentChunk', 'User'].map((t) => ({
    table_schema: 'public',
    table_name: t,
    table_owner: currentUser,
  }))
}

mock.module('@/lib/db', () => ({
  db: {
    // Applies the predicates it finds in the incoming SQL, like the real catalog would.
    // Unrecognised queries return [] so an accidental extra read is loud, not silent.
    $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
      queryRawCalls.push({ strings: [...strings], values })
      const sql = [...strings].join('?')
      /*
       * The mock models the REAL catalog, which an integration review proved the first version did not:
       * information_schema.tables has no table_owner column at all, so the original mock answered a
       * query Postgres itself rejects with 42703 — a fantasy catalog that could never fail (silent-failure
       * class 20). The ownership read now goes through pg_catalog.pg_class + pg_roles, exactly as the script
       * does, and the array predicate is matched as `= ANY(...)::text[]` because that is how $queryRaw
       * actually binds an array (the `IN (${tables})` form never reaches the database as a list).
       */
      if (sql.includes('pg_catalog.pg_class')) {
        const wantsPublicNamespace = sql.includes("relnamespace = 'public'::regnamespace")
        const wantsOwned = sql.includes('rolname = current_user')
        const wanted = Array.isArray(values[0]) ? (values[0] as string[]) : values.filter((v): v is string => typeof v === 'string')
        return schemaTables
          .filter((t) => !wantsPublicNamespace || t.table_schema === 'public')
          .filter((t) => !wantsOwned || t.table_owner === currentUser)
          .filter((t) => wanted.length === 0 || wanted.includes(t.table_name))
          .map((t) => ({ table_name: t.table_name }))
      }
      if (!sql.includes('information_schema.columns')) return []
      const wantsOrgColumn = sql.includes("column_name = 'organizationId'")
      const wantsPublicSchema = sql.includes("table_schema = 'public'")
      const rows = schemaColumns.filter(
        (r) => (!wantsOrgColumn || r.column_name === 'organizationId') && (!wantsPublicSchema || r.table_schema === 'public'),
      )
      const names = [...new Set(rows.map((r) => r.table_name))]
      return names.map((table_name) => ({ table_name }))
    },
    $executeRawUnsafe: async (sql: string) => {
      ddlStatements.push(sql)
      return 1
    },
  },
}))

import { connectingRole, discoverTenantTables, dropStatements, enableStatements, main, ownedTables, parseArgs } from './enable-rls'

beforeEach(() => {
  queryRawCalls = []
  ddlStatements = []
  currentUser = 'app_owner'
  seedCatalog()
})

/** Captures console output while main(argv) runs, so assertions can read the operator report. */
async function runMain(argv: string[]): Promise<string> {
  const lines: string[] = []
  const origLog = console.log
  console.log = ((...a: unknown[]) => {
    lines.push(a.map(String).join(' '))
  }) as unknown as typeof console.log
  try {
    await main(argv)
  } finally {
    console.log = origLog
  }
  return lines.join('\n')
}

describe('parseArgs — report is the default, drop is never implicit', () => {
  test('no flags is REPORT mode', () => {
    expect(parseArgs([])).toEqual({ mode: 'report', apply: false, drop: false })
  })
  test('--apply is APPLY mode', () => {
    expect(parseArgs(['--apply'])).toEqual({ mode: 'apply', apply: true, drop: false })
  })
  test('--drop alone is still REPORT (both halves must be explicit)', () => {
    expect(parseArgs(['--drop'])).toEqual({ mode: 'report', apply: false, drop: true })
  })
  test('--drop --apply is DROP mode', () => {
    expect(parseArgs(['--drop', '--apply'])).toEqual({ mode: 'drop', apply: true, drop: true })
  })
})

describe('connectingRole — the safety check reads DATABASE_URL, never the password', () => {
  test('extracts the username from a standard URL', () => {
    expect(connectingRole('postgresql://ryasai:ryasai_dev@localhost:5432/ryasai')).toBe('ryasai')
  })
  test('a URL with no userinfo reports null rather than throwing', () => {
    expect(connectingRole('postgresql://localhost:5432/x')).toBeNull()
  })
  test('an unparseable string reports null rather than crashing the script', () => {
    expect(connectingRole('not a url')).toBeNull()
  })
})

describe('discoverTenantTables — the table list comes from the database', () => {
  test('returns the public tables that carry organizationId, and only those', async () => {
    const tables = await discoverTenantTables()
    expect(tables).toEqual(['ChatSession', 'DocumentChunk', 'User'])
  })
  test('the discovery SQL hits information_schema with both predicates and DISTINCT', async () => {
    await discoverTenantTables()
    expect(queryRawCalls).toHaveLength(1)
    const sql = queryRawCalls[0].strings.join('?')
    expect(sql).toContain('information_schema.columns')
    expect(sql).toContain("column_name = 'organizationId'")
    expect(sql).toContain("table_schema = 'public'")
    expect(sql).toContain('DISTINCT')
  })
})

describe('ownedTables — the safety check asks the database who owns what', () => {
  test('by default the connecting role owns every tenant table', async () => {
    const owned = await ownedTables(['ChatSession', 'DocumentChunk', 'User'])
    expect(owned).toEqual(['ChatSession', 'DocumentChunk', 'User'])
  })
  test('a separate owner role owns none, and the warning must say so', async () => {
    schemaTables = []
    const owned = await ownedTables(['ChatSession'])
    expect(owned).toEqual([])
  })
  test('partial ownership is reported as such, not rounded to "all"', async () => {
    schemaTables = [{ table_schema: 'public', table_name: 'User', table_owner: currentUser }]
    const owned = await ownedTables(['ChatSession', 'User'])
    expect(owned).toEqual(['User'])
  })
  test('an empty table list short-circuits without a query', async () => {
    await ownedTables([])
    expect(queryRawCalls).toHaveLength(0)
  })
  test('the ownership SQL reads ownership from pg_catalog and filters on the connecting role', async () => {
    /*
     * MEASURED against a live Postgres 16: information_schema.tables has NO table_owner column, so the
     * original assertion demanded a query the database rejects (42703). Ownership lives in
     * pg_catalog.pg_class.relowner joined to pg_roles; the array predicate must be = ANY(...) because
     * $queryRaw binds a JS array as one text[] parameter, never as an IN list.
     */
    await ownedTables(['User'])
    const sql = queryRawCalls[0].strings.join('?')
    expect(sql).toContain('pg_catalog.pg_class')
    expect(sql).not.toContain('information_schema.tables')
    expect(sql).toContain('pg_roles')
    expect(sql).toContain('current_user')
    expect(sql).toContain('= ANY(')
  })
})

describe('the owner warning scales with what the catalog says', () => {
  test('owns-everything names the on-prem shape and the exact verification SQL', async () => {
    const out = await runMain([])
    expect(out).toContain('owns EVERY tenant table')
    expect(out).toContain('SELECT current_user, current_setting(\'app.current_org\', true) AS org;')
  })
  test('owns-nothing says the owner is elsewhere rather than claiming FORCE binds it', async () => {
    schemaTables = []
    const out = await runMain([])
    expect(out).toContain('owns NONE of the tenant tables')
    expect(out).not.toContain('owns EVERY tenant table')
  })
  test('partial ownership is called out as partial', async () => {
    schemaTables = [{ table_schema: 'public', table_name: 'User', table_owner: currentUser }]
    const out = await runMain([])
    expect(out).toContain('owns SOME tenant tables')
  })
})

describe('enableStatements — one ENABLE, one FORCE, one CREATE POLICY', () => {
  test('emits exactly three statements per table', () => {
    const s = enableStatements('User')
    expect(s).toHaveLength(3)
    expect(s[0]).toBe('ALTER TABLE "User" ENABLE ROW LEVEL SECURITY;')
    expect(s[1]).toBe('ALTER TABLE "User" FORCE ROW LEVEL SECURITY;')
    expect(s[2]).toBe(
      'CREATE POLICY "User_org_isolation" ON "User" USING ("organizationId" = current_setting(\'app.current_org\', true)::text);',
    )
  })
  test('the policy reads current_setting with the missing_ok flag', () => {
    expect(enableStatements('User')[2]).toContain("current_setting('app.current_org', true)")
  })
  test('the policy name is per-table, so two tables never share one', () => {
    expect(enableStatements('User')[2]).not.toBe(enableStatements('ChatSession')[2])
  })
})

describe('dropStatements — the rollback removes the policy AND lifts the FORCE', () => {
  test('emits DROP POLICY, NO FORCE, DISABLE', () => {
    const s = dropStatements('User')
    expect(s).toHaveLength(3)
    expect(s[0]).toBe('DROP POLICY IF EXISTS "User_org_isolation" ON "User";')
    expect(s[1]).toBe('ALTER TABLE "User" NO FORCE ROW LEVEL SECURITY;')
    expect(s[2]).toBe('ALTER TABLE "User" DISABLE ROW LEVEL SECURITY;')
  })
})

// --------------------------------------------------------------------------
// main() end-to-end, against the mocked catalog — the report/apply/drop contract.
// --------------------------------------------------------------------------

describe('REPORT mode (default) issues NO DDL but DOES query information_schema', () => {
  test('the captured statement list is empty, and the discovery query ran exactly once', async () => {
    await runMain([])
    // The whole safety property of the default: an operator can run this on production
    // blind and change nothing. EMPTY, not "no ENABLE" — a partial assertion would let
    // an unrelated statement slip through unreviewed.
    expect(ddlStatements).toEqual([])
    // TWO reads, both of them information_schema: the column discovery and the ownership
    // check that decides how dangerous FORCE is. No third read, and no DDL.
    expect(queryRawCalls).toHaveLength(2)
    const sqls = queryRawCalls.map((c) => c.strings.join('?'))
    expect(sqls.filter((sql) => sql.includes('information_schema.columns'))).toHaveLength(1)
    expect(sqls.filter((sql) => sql.includes('pg_catalog.pg_class'))).toHaveLength(1)
  })

  test('the printed report names every tenant table and the statements it would run', async () => {
    const out = await runMain([])
    expect(out).toContain('DocumentChunk')
    expect(out).toContain('ChatSession')
    expect(out).toContain('User')
    expect(out).toContain('ENABLE ROW LEVEL SECURITY')
    expect(out).toContain("current_setting('app.current_org', true)")
    expect(out).toContain('Report only')
  })

  test('the owner warning and the pool-config verification SQL print in report mode too', async () => {
    const out = await runMain([])
    // The warning must be readable BEFORE --apply, and must name the exact SQL an operator
    // runs on a live pool connection to check the GUC is set.
    expect(out).toContain('FORCE')
    expect(out).toContain('app.current_org')
    expect(out).toContain("SELECT current_user, current_setting('app.current_org', true) AS org;")
    expect(out).toContain('OUT OF SCOPE')
  })

  test('a database with no tenant tables reports nothing to do and still issues no DDL', async () => {
    schemaColumns = []
    const out = await runMain([])
    expect(out).toContain('Nothing to do')
    expect(ddlStatements).toEqual([])
  })
})

describe('APPLY mode issues exactly one ENABLE, one FORCE and one CREATE POLICY per table', () => {
  test('three tenant tables produce nine statements, contiguous per table', async () => {
    await runMain(['--apply'])
    expect(ddlStatements).toHaveLength(9)
    // Order matters: the policy is created only after RLS is on and FORCED, and one
    // table's statements are contiguous, so a failure halfway leaves that table's state
    // readable rather than interleaved across all of them.
    expect(ddlStatements.slice(0, 3)).toEqual([
      'ALTER TABLE "ChatSession" ENABLE ROW LEVEL SECURITY;',
      'ALTER TABLE "ChatSession" FORCE ROW LEVEL SECURITY;',
      'CREATE POLICY "ChatSession_org_isolation" ON "ChatSession" USING ("organizationId" = current_setting(\'app.current_org\', true)::text);',
    ])
    expect(ddlStatements.filter((s) => s.startsWith('ALTER TABLE') && s.endsWith('ENABLE ROW LEVEL SECURITY;'))).toHaveLength(3)
    expect(ddlStatements.filter((s) => s.startsWith('ALTER TABLE') && s.endsWith('FORCE ROW LEVEL SECURITY;'))).toHaveLength(3)
    expect(ddlStatements.filter((s) => s.startsWith('CREATE POLICY'))).toHaveLength(3)
  })

  test('every policy reads current_setting with the missing_ok flag', async () => {
    await runMain(['--apply'])
    const policies = ddlStatements.filter((s) => s.startsWith('CREATE POLICY'))
    expect(policies).toHaveLength(3)
    for (const p of policies) expect(p).toContain("current_setting('app.current_org', true)")
  })

  test('neither decoy is touched — the table without organizationId, and the non-public schema', async () => {
    await runMain(['--apply'])
    expect(ddlStatements.some((s) => s.includes('"Organization"'))).toBe(false)
    expect(ddlStatements.some((s) => s.includes('"OutOfScopeSchema"'))).toBe(false)
  })

  test('the completion line warns that an unset GUC means zero rows', async () => {
    const out = await runMain(['--apply'])
    expect(out).toContain('ZERO ROWS')
  })
})

describe('DROP mode removes the policies and lifts the FORCE per table', () => {
  test('--drop --apply issues DROP POLICY, NO FORCE and DISABLE for every tenant table', async () => {
    await runMain(['--drop', '--apply'])
    expect(ddlStatements.filter((s) => s.startsWith('DROP POLICY'))).toHaveLength(3)
    expect(ddlStatements.filter((s) => s.includes('NO FORCE ROW LEVEL SECURITY'))).toHaveLength(3)
    expect(ddlStatements.filter((s) => s.endsWith('DISABLE ROW LEVEL SECURITY;'))).toHaveLength(3)
    // The rollback must not enable anything or create anything.
    expect(ddlStatements.some((s) => s.endsWith('ENABLE ROW LEVEL SECURITY;'))).toBe(false)
    expect(ddlStatements.some((s) => s.startsWith('CREATE POLICY'))).toBe(false)
  })

  test('neither decoy is touched by the rollback either', async () => {
    await runMain(['--drop', '--apply'])
    expect(ddlStatements.some((s) => s.includes('"Organization"'))).toBe(false)
    expect(ddlStatements.some((s) => s.includes('"OutOfScopeSchema"'))).toBe(false)
  })

  test('--drop WITHOUT --apply is report-only: it prints the rollback SQL and issues nothing', async () => {
    const out = await runMain(['--drop'])
    expect(out).toContain('DROP POLICY')
    expect(out).toContain('NO FORCE ROW LEVEL SECURITY')
    expect(out).toContain('Report only')
    expect(ddlStatements).toEqual([])
  })
})

  test('the array is bound as ANY, never as an IN list — the form $queryRaw actually supports', async () => {
    /*
     * MEASURED against the live database: $queryRaw binds a JS array as ONE text[] parameter, so
     * `IN (${tables})` raises 42883 (operator does not exist: information_schema.sql_identifier = text[])
     * and the script crashed in REPORT mode before an operator ever saw the warning it exists to print.
     * The corrected mock models the real binding, so reverting to the IN form must fail HERE rather than
     * only in production — the property the fantasy-catalog mock could not give us.
     */
    const src = await Bun.file(new URL('./enable-rls.ts', import.meta.url)).text()
    // Comments are stripped: this script's own comments EXPLAIN why the IN form is wrong, so asserting
    // on the whole file would fail on the fix's own notes — the vacuous-guard shape this repo records.
    const code = src
      .split('\n')
      .map((l) => (l.trimStart().startsWith('*') || l.trimStart().startsWith('//') || l.trimStart().startsWith('/*') ? '' : l))
      .join('\n')
    expect(code).toContain('= ANY(${tables}::text[])')
    expect(code).not.toContain('IN (${tables})')
  })
