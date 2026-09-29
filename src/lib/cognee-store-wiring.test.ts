import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * cognee's relational + vector + cache stores are the BUNDLED POSTGRES, in cognee's own database;
 * the graph stays on embedded Kuzu.
 *
 * WHY THIS GUARD EXISTS. Every one of these settings fails SILENTLY when it regresses. Reverting
 * `DB_PROVIDER=postgres` to `sqlite` does not raise anything: cognee happily boots on the
 * pre-existing local files and memory writes land somewhere nobody looks. The container reports
 * healthy, `/health` returns 200, and the only symptom is that memory written before the change is
 * gone from the UI. There is no log line, no error, and nothing an operator would think to check.
 *
 * The facts below were MEASURED against cognee/cognee:1.6.0 and this repo's compose, not inferred
 * from documentation (the vendor docs are wrong about several of these):
 *
 *   * cognee CANNOT share the app's database. The `migrate` service runs `prisma db push` on every
 *     boot, and push treats unknown tables as drift. MEASURED on a scratch database: an unknown
 *     EMPTY table is DROPPED SILENTLY ("Your database is now in sync"), while an unknown table WITH
 *     ROWS makes push REFUSE the whole boot. Sharing would therefore either lose memory quietly or
 *     stop the app from starting — hence a separate database, same instance.
 *
 *   * The database must ALREADY EXIST. cognee EXITS(1) on a missing one; the last line is
 *     `asyncpg.exceptions.InvalidCatalogNameError: database "..." does not exist`. With
 *     `restart: unless-stopped` that becomes a loop that reads as a crash rather than a missing
 *     step, which is why `cognee-db-init` exists instead of a note in the docs.
 *
 *   * `DB_PORT` is NOT optional. cognee passes it to asyncpg as `int(db_port)` and the config
 *     default is None, so omitting it fails with `TypeError: int() argument must be a string ...
 *     or a number, not 'NoneType'` — a message that never mentions a port.
 *
 *   * Omitting the `VECTOR_DB_*` group still works (it falls back to `DB_*`) but logs
 *     "PGVector credentials are not fully configured; falling back to the relational database
 *     configuration." on EVERY boot. A warning that fires on a healthy install is how a real one
 *     gets ignored, so the group is set explicitly and that is pinned here.
 *
 *   * `CACHE_BACKEND=postgres` must come WITHOUT `CACHE_DB_URL`. With no URL the cache reuses the
 *     relational connection, so alembic revision c3d5e7f9a1b2 sees one database and returns early;
 *     a SEPARATE cache database is rejected by that same migration and the sidecar never becomes
 *     healthy. (Its docstring: "There is no runtime fallback.")
 *
 *   * `ENABLE_BACKEND_ACCESS_CONTROL` defaults ON for exactly the provider pair we now use
 *     (pgvector + a Postgres graph). Both files pin it false; removing the line silently changes
 *     how datasets are isolated rather than failing.
 *
 *   * The graph DELIBERATELY stays Kuzu. Upstream labels its Postgres graph adapter a demo —
 *     "Using Postgres as a graph store is currently a demo feature and is not production-ready" —
 *     which is also why the `cogneedata` volume is still required.
 */

const root = join(import.meta.dir, '..', '..')
const repoCompose = readFileSync(join(root, 'docker-compose.yml'), 'utf-8')
const installSh = readFileSync(join(root, 'install.sh'), 'utf-8')

/**
 * Rebuild the compose that `install.sh` generates. Three heredocs appended in sequence (`cat >`
 * then `cat >>` twice), so all of them must be concatenated or the YAML is a fragment with no
 * `services:` tail.
 */
function generatedCompose(): string {
  const lines = installSh.split('\n')
  const out: string[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (
      line.startsWith('cat > docker-compose.prod.yml <<') ||
      line.startsWith('cat >> docker-compose.prod.yml <<')
    ) {
      const end = lines.findIndex((l, j) => j > i && l.trim() === 'EOF')
      if (end === -1) throw new Error('unterminated compose heredoc')
      out.push(...lines.slice(i + 1, end))
      i = end + 1
    } else {
      i += 1
    }
  }
  return out.join('\n')
}

/**
 * Extract one service block by indentation (2-space service keys), stopping at the next top-level
 * key. A YAML parser would be better but none is a dependency of this repo, and the generated
 * heredoc is a TEMPLATE containing `${VAR:-default}` that would not parse as YAML anyway.
 */
function serviceBlock(compose: string, name: string): string {
  const lines = compose.split('\n')
  const start = lines.findIndex((l) => new RegExp(`^ {2}${name}:\\s*$`).test(l))
  if (start === -1) throw new Error(`service ${name} not found in compose`)
  let end = lines.length
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^ {2}\S/.test(lines[i]) && !lines[i].trimStart().startsWith('#')) {
      end = i
      break
    }
  }
  return lines.slice(start, end).join('\n')
}

/**
 * Strip `#` comments. LOAD-BEARING, not tidiness: every one of these files explains its own
 * settings in prose that quotes the very strings being asserted, so a raw text search would pass
 * on a comment after the real line was deleted. This project has already paid for that once — a
 * negative control that deleted the `.env.cognee` env_file entry still passed because the
 * surrounding comment contained the same string.
 */
const stripComments = (src: string) =>
  src
    .split('\n')
    .map((line) => {
      const hash = line.indexOf('#')
      return (hash === -1 ? line : line.slice(0, hash)).trimEnd()
    })
    .join('\n')

/**
 * The environment entries of a service, as `- KEY=value` list items. Listed rather than searched:
 * an entry must be an actual item of `environment:`, because that is what compose reads and what
 * overrides an env_file. A bare `DB_PROVIDER=postgres` in prose is not a setting.
 */
function envEntries(block: string): Map<string, string> {
  const entries = new Map<string, string>()
  for (const line of stripComments(block).split('\n')) {
    const m = /^\s*-\s+([A-Z][A-Z0-9_]*)=(.*)$/.exec(line)
    if (m) entries.set(m[1], m[2].trim())
  }
  return entries
}

/** The database name the APP itself uses, taken from its own DATABASE_URL. */
function appDatabaseName(compose: string): string {
  const m = /DATABASE_URL=postgresql:\/\/[^/@\s]*@[^/\s]*\/([A-Za-z0-9_]+)/.exec(stripComments(compose))
  if (!m) throw new Error('could not derive the app database name from DATABASE_URL')
  return m[1]
}

const sources = [
  { label: 'docker-compose.yml (local)', compose: repoCompose },
  { label: 'docker-compose.prod.yml (generated by install.sh)', compose: generatedCompose() },
]

for (const { label, compose } of sources) {
  describe(`cognee store wiring — ${label}`, () => {
    const block = serviceBlock(compose, 'cognee')
    const env = envEntries(block)

    test('relational, vector and cache all run on Postgres', () => {
      expect(env.get('DB_PROVIDER')).toBe('postgres')
      expect(env.get('VECTOR_DB_PROVIDER')).toBe('pgvector')
      expect(env.get('CACHE_BACKEND')).toBe('postgres')
    })

    test('cognee uses its OWN database, never the one prisma db push manages', () => {
      const appDb = appDatabaseName(compose)
      const cogneeDb = env.get('DB_NAME')
      expect(cogneeDb, 'DB_NAME must be set explicitly').toBeTruthy()
      // The whole point of the init service. Measured: an unknown EMPTY table is dropped silently
      // by the next `prisma db push`, and a non-empty one makes push refuse to boot the app.
      expect(
        cogneeDb,
        `cognee's DB_NAME must not be the app's own database (${appDb}) — prisma db push runs on ` +
          `every boot and treats cognee's tables as schema drift`,
      ).not.toBe(appDb)
    })

    test('DB_PORT is set, and lies on the same instance as the app', () => {
      // Not cosmetic: cognee feeds this to asyncpg via int(), and the config default is None, so a
      // missing port dies with a TypeError about NoneType rather than anything naming a port.
      const port = env.get('DB_PORT')
      expect(port, 'DB_PORT must be set or cognee crashes on int(None)').toBeTruthy()
      const appUrl = /DATABASE_URL=postgresql:\/\/[^/@\s]*@([^:/\s]+):(\d+)\//.exec(stripComments(compose))
      expect(appUrl, 'app DATABASE_URL must carry host and port').toBeTruthy()
      expect(port).toBe(appUrl![2])
      expect(env.get('DB_HOST')).toBe(appUrl![1])
      expect(env.get('DB_USERNAME')).toBeTruthy()
      expect(env.get('DB_PASSWORD')).toBeTruthy()
    })

    test('the VECTOR_DB_* group is explicit, so no fallback warning is logged', () => {
      // Values must MATCH the relational ones: the fallback that this replaces did exactly that,
      // so an explicit set that disagreed would be a different bug wearing this guard's clothes.
      for (const key of ['VECTOR_DB_HOST', 'VECTOR_DB_PORT', 'VECTOR_DB_NAME', 'VECTOR_DB_USERNAME', 'VECTOR_DB_PASSWORD']) {
        expect(env.get(key), `${key} must be set explicitly`).toBeTruthy()
      }
      expect(env.get('VECTOR_DB_HOST')).toBe(env.get('DB_HOST'))
      expect(env.get('VECTOR_DB_PORT')).toBe(env.get('DB_PORT'))
      expect(env.get('VECTOR_DB_NAME')).toBe(env.get('DB_NAME'))
      expect(env.get('VECTOR_DB_USERNAME')).toBe(env.get('DB_USERNAME'))
      expect(env.get('VECTOR_DB_PASSWORD')).toBe(env.get('DB_PASSWORD'))
    })

    test('CACHE_DB_URL is absent, so the cache reuses one database', () => {
      // A separate cache database is rejected by alembic c3d5e7f9a1b2 and the sidecar never becomes
      // healthy — the migration's own docstring says there is no runtime fallback.
      expect(env.has('CACHE_DB_URL')).toBe(false)
    })

    test('ENABLE_BACKEND_ACCESS_CONTROL stays off', () => {
      // Its default flips ON for exactly the pgvector + Postgres-graph pair, so deleting this line
      // changes how datasets are isolated without failing anything.
      expect(env.get('ENABLE_BACKEND_ACCESS_CONTROL')).toBe('false')
    })

    test('the graph stays on embedded Kuzu', () => {
      expect(env.get('GRAPH_DATABASE_PROVIDER')).toBe('kuzu')
    })

    test('cognee waits for its database, and the wait is on the init service', () => {
      const code = stripComments(block)
      expect(code).toMatch(/depends_on:/)
      expect(code).toMatch(/cognee-db-init:\s*\{\s*condition:\s*service_completed_successfully\s*\}/)
    })

    test('cognee-db-init creates that database idempotently, before cognee starts', () => {
      const init = stripComments(serviceBlock(compose, 'cognee-db-init'))
      const dbName = env.get('DB_NAME')!
      // The name created must be the name cognee is told to use — otherwise the init service runs,
      // succeeds, and the sidecar still exits with InvalidCatalogNameError.
      expect(init).toContain(`datname='${dbName}'`)
      // CREATE DATABASE has no IF NOT EXISTS, so idempotence comes from the guard-and-create shape:
      // the existence check must FALL THROUGH to `createdb` on failure. Asserting the pipe into
      // `grep -q` followed directly by `|| createdb` is asserting the mechanism; a looser match on
      // the word `createdb` would pass on a comment or on a `createdb` that never runs.
      expect(init).toMatch(/grep -q 1\s*\|\|\s*createdb/)
      // And it must not race Postgres itself.
      expect(init).toMatch(/db:\s*\{\s*condition:\s*service_healthy\s*\}/)
    })
  })
}
