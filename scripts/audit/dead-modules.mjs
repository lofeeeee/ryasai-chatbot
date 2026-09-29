/**
 * Report source modules that NOTHING imports.
 *
 * WHY THIS EXISTS AS A SCRIPT AND NOT AS A ONE-OFF: "is this file used?" came up while cleaning the repo, and the
 * first attempt answered it with `grep -r`, which reported 46 orphans including `chat-view.tsx` and `use-chat-send.ts`
 * — files that are obviously used. A recursive grep matches a file's own contents and matches SUBSTRINGS, so
 * `grep -rl toggle` "found" consumers for an unused `toggle.tsx` via the local variable `toggleSidebar`. This
 * resolves real import specifiers instead, so the answer is a measurement rather than an impression.
 *
 * Usage: node scripts/audit/dead-modules.mjs [--include-app]
 *   By default `src/app/**` is excluded: route and page files are entered by Next.js routing, not by an import, so
 *   they always look unimported and would drown the signal.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'

const ROOT = process.cwd()
const includeApp = process.argv.includes('--include-app')
const DIRS = ['src', 'mini-services', 'scripts', 'e2e']

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.next' || entry.startsWith('.')) continue
    const p = join(dir, entry)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.(ts|tsx|mjs)$/.test(entry)) out.push(p)
  }
  return out
}

const files = DIRS.flatMap((d) => { try { return walk(d) } catch { return [] } })

// Map every resolvable specifier to the files that import it.
const importers = new Map()
for (const file of files) {
  const src = readFileSync(file, 'utf8')
  const specs = [...src.matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)].map((m) => m[1])
  for (const spec of specs) {
    let target
    if (spec.startsWith('@/')) target = resolve(ROOT, 'src', spec.slice(2))
    else if (spec.startsWith('.')) target = resolve(dirname(file), spec)
    else continue // bare package specifier
    for (const ext of ['', '.ts', '.tsx', '/index.ts', '/index.tsx']) {
      const candidate = target + ext
      try {
        if (statSync(candidate).isFile()) {
          if (!importers.has(candidate)) importers.set(candidate, new Set())
          importers.get(candidate).add(file)
          break
        }
      } catch { /* not this extension */ }
    }
  }
}

/*
 * Files that are ENTERED rather than imported, so "unimported" is correct and meaningless:
 *   - `src/app/**`  : Next.js routing (also `src/instrumentation.ts`, resolved by convention).
 *   - `*.test.ts(x)`: the runner discovers these.
 *   - `__fixtures__`, `__mocks__`: loaded by path from tests.
 */
const isEntryPoint = (f) =>
  (!includeApp && f.startsWith('src/app/')) ||
  f === 'src/instrumentation.ts' ||
  f === 'src/middleware.ts' ||
  /\.(test|integration)\./.test(f) ||
  f.includes('__fixtures__') || f.includes('__mocks__') ||
  /^scripts\//.test(f)

const candidates = files.filter((f) => f.startsWith(('src/')) && !isEntryPoint(f))
const orphans = candidates.filter((f) => !importers.has(resolve(ROOT, f))).sort()

console.log(`  modules analysed : ${candidates.length}`)
console.log(`  NOT imported     : ${orphans.length}`)
for (const o of orphans) console.log(`    ${o}`)
if (orphans.length > 0) {
  console.log('\n  Each needs a verdict: delete it, or add it to the entry-point list above WITH a reason.')
}
