/**
 * Dependency security, pinned as a test.
 *
 * WHY THIS EXISTS
 * ----------------------------------------------------------------------------
 * `bun audit` is a command an operator has to REMEMBER to run, so a vulnerability that appears during a routine
 * `bun add` is invisible until someone audits deliberately. Worse, the three packages left after `bun audit fix`
 * look identical in that report while being completely different risks:
 *
 *   - `prismjs` is reachable from the BROWSER. `react-syntax-highlighter` pins `refractor@3.6.0`, which depends on
 *     `prismjs@~1.27.0`; that copy is bundled into a client chunk. Switching the highlighter's own dependency
 *     would need a major bump, so the resolution is fixed with a `prismjs` override instead.
 *   - `deepmerge-ts` and `effect` are pulled in by `@prisma/config@6.19.2` (via the `prisma` CLI, which ships in the
 *     scheduler image because the `migrate` service runs `prisma db push` on every boot). They are NOT in the app
 *     image: measured, `.next/standalone/node_modules` contains neither. They are declared high-severity, so they
 *     are asserted HERE rather than in prose, and the day they are fixed the test tells you to delete the entry.
 *
 * This test reads the LOCKFILE and node_modules rather than invoking the registry, so it needs no network.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')

/**
 * Packages whose advisory is accepted, each with the reason. An entry that no longer applies must be REMOVED —
 * a stale exception makes the next reviewer discount the whole list.
 */
const ACCEPTED: Array<{ name: string; reason: string }> = [
  {
    name: 'deepmerge-ts',
    reason:
      'stack exhaustion on a recursive object graph, reached only through @prisma/config in the prisma CLI (the ' +
      'migrate service). Not present in the app image (verified by asserting its absence below). @prisma/config ' +
      'pins 7.1.5 exactly and no stable 6.x release lets go of it.',
  },
  {
    name: 'effect',
    reason:
      'AsyncLocalStorage context loss under concurrent RPC load, same @prisma/config 6.19.2 path and the same ' +
      'absence from the app image. Pinned exactly; released only in effect >= 3.20, which 6.x does not accept.',
  },
]

const readJson = (path: string): Record<string, unknown> => JSON.parse(readFileSync(path, 'utf8'))

describe('the installed Next.js is not a version with an unauthenticated RCE', () => {
  /**
   * Two CRITICAL advisories are fixed only in >= 16.3.3: unauthenticated RCE on Windows-hosted servers, and
   * unauthenticated RCE through the Image Optimization API when AVIF is used. The second is the one that matters
   * for THIS app: it calls `next/image` in login-view.tsx and topbar.tsx, so the optimizer is live and reachable
   * before anyone logs in. A declared range of "^16.1.1" would happily reinstall a vulnerable version on a fresh
   * `bun install`, which is why the floor is asserted rather than trusted.
   */
  const RCE_FIXED_IN = [16, 3, 3] as const
  const parse = (v: string): number[] => v.split('.').map((n) => Number(n.replace(/\D/g, '')))

  test('the declared range cannot resolve below the fix', () => {
    const declared = readJson(join(ROOT, 'package.json')).dependencies as Record<string, string>
    const floor = parse(declared.next.replace(/^[^\d]*/, ''))
    const [major, minor, patch] = RCE_FIXED_IN
    const belowFix =
      floor[0] < major ||
      (floor[0] === major && floor[1] < minor) ||
      (floor[0] === major && floor[1] === minor && floor[2] < patch)
    expect(belowFix, `next is declared "${declared.next}", which allows a version below ${RCE_FIXED_IN.join('.')}`).toBe(false)
  })

  test('the version actually installed is at or above the fix', () => {
    const installed = readJson(join(ROOT, 'node_modules', 'next', 'package.json')).version as string
    const v = parse(installed)
    const [major, minor, patch] = RCE_FIXED_IN
    const below =
      v[0] < major || (v[0] === major && v[1] < minor) || (v[0] === major && v[1] === minor && v[2] < patch)
    expect(below, `next ${installed} is below the RCE fix ${RCE_FIXED_IN.join('.')}`).toBe(false)
  })
})

describe('vulnerable dependencies cannot re-enter the shipped app', () => {
  test('prismjs has exactly ONE resolution, and it is a patched one', () => {
    // Two copies is the failure mode: `react-syntax-highlighter` reaching its own vulnerable `refractor` copy while
    // a clean one sits at the top level. The override in package.json is what collapses them, so this asserts the
    // RESULT of the override (resolution), not the presence of the override text.
    const overrides = readJson(join(ROOT, 'package.json')).overrides as Record<string, string> | undefined
    expect(overrides?.prismjs).toBe('1.30.0')

    const lock = readFileSync(join(ROOT, 'bun.lock'), 'utf8')
    const copies = [...lock.matchAll(/"prismjs":\s*\["prismjs@([0-9.]+)"/g)].map((m) => m[1])
    for (const version of copies) {
      // DOM Clobbering was fixed in 1.30.0; anything below is the CVE the override exists to remove.
      expect(version, `prismjs ${version} resolves below the patched 1.30.0`).toBe('1.30.0')
    }
    expect(copies.length, 'the lockfile must pin prismjs at least once').toBeGreaterThan(0)
  })

  // This guard has TWO halves, and the second is only meaningful with a build on disk.
  //
  // MEASURED: with `.next/` moved away, the original single test still PASSED — it asserted that a package.json
  // was absent, and a missing build makes every file absent. CI runs the unit suite before any build, so there it
  // guarded nothing while reporting green. The premise is now asserted FIRST (a package that MUST be in the image is
  // visible to the same probe), and when there is no build the test is SKIPPED rather than passed: a skip shows up
  // in the runner's count, a green tick that checked nothing does not.
  const standalone = join(ROOT, '.next', 'standalone', 'node_modules')
  const haveBuild = Bun.file(join(standalone, 'next', 'package.json')).size > 0

  test.skipIf(!haveBuild)('the accepted advisories are still accepted: the packages are NOT in the app image', () => {
    // If one of these ever reaches `.next/standalone`, its advisory is no longer a CLI-only concern and this test's
    // premise is false — the failure message says what changed. Presence is probed by reading the package manifest
    // inside each candidate directory, the only filesystem check that works without a directory listing.
    expect(Bun.file(join(standalone, 'next', 'package.json')).size, 'the probe must be able to see a real package').toBeGreaterThan(0)
    for (const { name } of ACCEPTED) {
      const manifest = join(standalone, name, 'package.json')
      expect(Bun.file(manifest).size, `${name} reached the standalone image; its accepted advisory must be re-assessed`).toBe(0)
    }
  })
})
