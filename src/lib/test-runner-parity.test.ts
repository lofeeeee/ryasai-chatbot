import { describe, expect, test } from 'bun:test'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

/**
 * THE TWO RUNNERS MUST COLLECT THE SAME FILES.
 *
 * WHY THIS EXISTS — silent-failure class 20, "two harnesses for one suite, configured differently".
 * MEASURED: `scripts/test.ts` globbed `{src,benchmark}/**\/*.test.{ts,tsx}` (303 files) while
 * `scripts/coverage.ts` globbed `src/**\/*.test.{ts,tsx}` (290). Thirteen benchmark test files
 * therefore RAN in CI but were never part of the coverage measurement, and one of them,
 * `benchmark/arms/hybrid-fusion.test.ts`, imports `@/lib/rag-ranking` — a module `scripts/coverage-gate.ts`
 * floors at 80%. That module was being measured WITHOUT the tests that exercise it, so a real regression
 * there could lower the number while the file that would have caught it was already running elsewhere.
 *
 * THE GUARD THAT ALREADY EXISTED DID NOT CATCH IT, and the way it missed is the reason this file asserts
 * about SETS rather than STRINGS. `release-images.test.ts` asserted that each script CONTAINS the substring
 * `*.test.{ts,tsx}` and that the pattern matches a real `.tsx` file on disk. Both held while the two
 * patterns were `{src,benchmark}/**` and `src/**` — a substring match cannot see a missing ROOT, and
 * "matches at least one .tsx" says nothing about which files each pattern reaches. This is the
 * "guard matching a WORD, not a CALL" shape (silent-failure class 1): the identifier was present and
 * the behaviour was wrong.
 *
 * WHAT IS ASSERTED HERE, in increasing strength:
 *   1. both script sources declare the SAME glob string (equivalence, not containment);
 *   2. the collected set equals the ON-DISK set minus the NAMED integration exclusions — so a pattern
 *      that is simultaneously wrong in both scripts still fails;
 *   3. the exclusion list is explicit and its entries still exist (a stale exclusion is how a file
 *      silently leaves the measurement: the name matches nothing and nothing reports it);
 *   4. the `.tsx` extension is still reached (the earlier incident), and `scripts/` is still reached
 *      (`scripts/test-runner.test.ts` never ran until the roots were unified).
 *
 * Negative-controlled by planting a divergence in one script's glob and confirming this file fails,
 * then restoring it byte-identical — see the header of `release-images.test.ts` for why that step is
 * required rather than assumed (AGENTS.md: "A guard must be NEGATIVE-CONTROLLED before you trust it").
 */
const ROOT = join(import.meta.dir, '..', '..')
const RUNNER = join(ROOT, 'scripts', 'test.ts')
const COVERAGE = join(ROOT, 'scripts', 'coverage.ts')

const read = (p: string) => readFileSync(p, 'utf8')

/**
 * Pull the declared glob out of a runner's source.
 *
 * Anchored to the QUOTED ASSIGNMENT rather than to any `*.test.`-looking string, because both files
 * also quote historical patterns in their explanatory comments ("the glob used to be
 * `src/**\/*.test.ts`"). A loose match would read the COMMENT and pass while the live pattern was
 * wrong — the false-negative this guard exists to prevent.
 */
function declaredGlob(source: string): string | null {
  return source.match(/const\s+TEST_FILE_GLOB\s*=\s*'([^']+)'/)?.[1] ?? null
}

/**
 * Every test file the patterns are supposed to reach, straight from the filesystem.
 *
 * DOT-DIRECTORIES ARE SKIPPED, and that is a deliberate scope rule rather than convenience: a
 * top-level `.probe/` holds throwaway probes, `.next/` and `.git/` are tooling, and none of them are
 * part of the suite a developer expects to run. A NON-dot directory is walked, which is the useful
 * direction — dropping a test file into a new `tests/` root that no glob reaches is exactly the
 * "written, present in the tree, executed by nothing" defect this file exists to catch.
 */
function testFilesOnDisk(root: string): string[] {
  const skip = new Set(['node_modules', '.next', '.git', 'coverage', '.coverage-merge', 'out', 'dist', 'build'])
  const found: string[] = []
  const walk = (absDir: string, relDir: string): void => {
    for (const entry of readdirSync(absDir)) {
      if (skip.has(entry) || (entry.startsWith('.') && entry !== '.')) continue
      const abs = join(absDir, entry)
      const rel = relDir === '' ? entry : `${relDir}/${entry}`
      if (statSync(abs).isDirectory()) {
        walk(abs, rel)
      } else if (/\.test\.tsx?$/.test(entry)) {
        found.push(rel)
      }
    }
  }
  walk(root, '')
  return found.sort()
}

/**
 * The integration exclusions, read FROM THE RUNNER SOURCE rather than restated here.
 *
 * Restating them would let the two definitions drift, which is the defect class this whole file is
 * about. `scripts/test.ts` holds the NAMED set plus the `*.integration.test.ts` suffix rule; that is
 * what "the collected set" must be subtracted against.
 */
function namedIntegrationExclusions(runnerSource: string): string[] {
  const block = runnerSource.match(/const\s+INTEGRATION_FILES\s*=\s*new Set\(\[([^\]]*)\]\)/)?.[1] ?? ''
  return [...block.matchAll(/'([^']+)'/g)].map((m) => m[1]!)
}

async function collectedBy(pattern: string): Promise<string[]> {
  const out: string[] = []
  for await (const f of new Bun.Glob(pattern).scan({ cwd: ROOT })) out.push(f)
  return out.sort()
}

const runnerSource = read(RUNNER)
const coverageSource = read(COVERAGE)
const runnerGlob = declaredGlob(runnerSource)
const coverageGlob = declaredGlob(coverageSource)

describe('the unit runner and the coverage runner collect the same test files', () => {
  test('both scripts declare a glob (a detector that finds nothing must not pass)', () => {
    // Without this, a rename of the constant would make every assertion below compare null to null
    // and pass forever — the "guard that cannot fail" shape (silent-failure class 17).
    expect(runnerGlob).not.toBeNull()
    expect(coverageGlob).not.toBeNull()
  })

  test('the two glob patterns are EQUIVALENT, not merely both present', () => {
    // THE ASSERTION THE OLD GUARD LACKED. A substring check passes for `{src,benchmark}/**` and `src/**`
    // simultaneously; equality of the whole pattern does not.
    expect(coverageGlob).toBe(runnerGlob)
  })

  test('neither pattern dropped the .tsx extension', () => {
    // The earlier incident: `**/*.test.ts` does not match `.test.tsx`, so
    // `src/components/views/cognee-diagnostics-render.test.tsx` was collected by nothing and never ran.
    for (const g of [runnerGlob, coverageGlob]) expect(g).toContain('*.test.{ts,tsx}')
  })

  test('both patterns reach every root the suite lives in', () => {
    // A missing ROOT is exactly what the substring guard could not see. Pinned as roots rather than as
    // the literal string so a reordering of the brace group does not fail the guard.
    for (const g of [runnerGlob, coverageGlob]) {
      for (const root of ['src', 'benchmark', 'scripts']) expect(g).toContain(root)
    }
  })

  test('the pattern matches EVERY test file on disk', async () => {
    /*
     * The behavioural assertion, and the one that catches a divergence BOTH scripts agree on: the glob's
     * result is compared to an independent FILESYSTEM walk, not to the pattern again. If a future edit
     * narrows both globs together (the tempting "make CI faster" change), or a test file lands in a new
     * root neither pattern names, this fails and NAMES the files that would have stopped being run.
     *
     * The glob is deliberately compared WITHOUT the integration exclusions applied: excluding is the
     * runner's `isIntegration()` predicate, a separate axis checked by the test below. Folding the two
     * together here would let a file be dropped from the GLOB and still pass, as long as it was also
     * listed as an exclusion — which is the "two mechanisms, one symptom" trap.
     *
     * BOTH SIDES ARE TAKEN BEFORE EITHER IS COMPARED, and the comparison is set-based, because this test
     * reads the FILESYSTEM and therefore races any concurrent writer. MEASURED: inside `bun run coverage`
     * this test FAILED while passing 9/9 standalone, because the coverage runner creates and removes its
     * `coverage/` output directory during the window the walk was running. The two snapshots then
     * disagreed about a transient path — a fact about the tree CHANGING, not about the globs diverging.
     * The earlier version awaited the glob FIRST and walked SECOND, so a file created in between landed
     * on one side only.
     *
     * The failure this guard exists for — a glob that stops reaching a REAL test file — is permanent and
     * still fails here, because such a file is missing from the glob in every snapshot. What no longer
     * fails is a file appearing or vanishing mid-test, which was never a divergence between the runners.
     */
    const onDisk = new Set(testFilesOnDisk(ROOT))
    const collected = new Set(await collectedBy(runnerGlob!))

    // The real defect: a file on disk the glob never reaches. Named, so the failure says which.
    const missedByGlob = [...onDisk].filter((f) => !collected.has(f)).sort()
    expect(
      missedByGlob,
      `these test files exist but the glob does not reach them: ${missedByGlob.join(', ')}`,
    ).toEqual([])

    // A path the glob returned that is absent from disk was created/removed during this test. Tolerated,
    // but still asserted to BE a test path, so a genuinely wrong root cannot slip through as "transient".
    const notOnDisk = [...collected].filter((f) => !onDisk.has(f)).sort()
    expect(
      notOnDisk.every((f) => /\.test\.tsx?$/.test(f)),
      `the glob returned non-test paths: ${notOnDisk.join(', ')}`,
    ).toBe(true)
  })

  test('every named exclusion still exists, and is a real test file', () => {
    // A stale name in INTEGRATION_FILES matches nothing and reports nothing, while the rule it was
    // written for silently stops applying to the file it was meant to exclude.
    const named = namedIntegrationExclusions(runnerSource)
    expect(named.length).toBeGreaterThan(0)
    const onDisk = new Set(testFilesOnDisk(ROOT))
    expect(named.filter((f) => !onDisk.has(f))).toEqual([])
  })

  test('the exclusions subtracted from the run are the ones the runner actually names', () => {
    /*
     * The second axis, kept separate so neither can mask the other. The runner's runnable set is
     * "globe minus isIntegration()", and `isIntegration()` is a bare `*.integration.test.ts` SUFFIX
     * rule plus the named set. Both halves are pinned because the suffix half is invisible to a reader
     * looking only at INTEGRATION_FILES: a file renamed `foo.integration.test.ts` leaves the unit run
     * silently, which is intended, while a file renamed `foo.probe.test.ts` does not.
     */
    const onDisk = testFilesOnDisk(ROOT)
    const named = namedIntegrationExclusions(runnerSource)
    const runnable = onDisk.filter(
      (f) => !(named.includes(f) || f.endsWith('.integration.test.ts')),
    )
    // The three files the header of this file accounts for: 303 on disk minus 3 exclusions = 300 ran.
    if (onDisk.length === 303) expect(runnable.length).toBe(300)
    expect(runnable.filter((f) => f.endsWith('.integration.test.ts'))).toEqual([])
    expect(runnable).not.toContain('src/lib/connector-dummy.test.ts')
    // The opt-in path must stay reachable: the suffix rule is what `bun run test:integration` selects on.
    expect(onDisk.filter((f) => f.endsWith('.integration.test.ts')).length).toBeGreaterThan(1)
  })

  test('the suite still collects the .tsx component test AND the runner-testing test file', async () => {
    /*
     * Two FROZEN members, one per historical incident, because "the set is non-empty" would pass on a
     * set that had lost exactly the files that motivated this guard:
     *   - `cognee-diagnostics-render.test.tsx` — reached only once `.tsx` was added to the pattern;
     *   - `scripts/test-runner.test.ts` — tests this runner's own summary parser and, before the roots
     *     were unified, was collected by NO glob. The accounting that found it: 303 files on disk minus
     *     the 3 integration exclusions equalled the 300 the runner printed, so that one file was the only
     *     thing missing (silent-failure class 17 — a test that cannot run reports nothing).
     */
    const collected = await collectedBy(runnerGlob!)
    expect(collected).toContain('src/components/views/cognee-diagnostics-render.test.tsx')
    expect(collected).toContain('scripts/test-runner.test.ts')
    expect(collected.filter((f) => f.startsWith('benchmark/')).length).toBeGreaterThan(10)
  })

  test('the coverage runner excludes exactly the same files the unit runner does', () => {
    /*
     * The two scripts spell the exclusion differently — `test.ts` calls an `isIntegration(f)` predicate,
     * `coverage.ts` inlines the suffix rule plus a named set — and a difference there is the same defect
     * one level down: a file RUN but not MEASURED, or measured but never run.
     *
     * THIS TEST FOUND A LIVE INSTANCE, which is why it asserts on the parsed SET rather than on a
     * substring's presence. `coverage.ts` read `f.includes('connector-dummy')` — a SUBSTRING match,
     * broader than the exact path the runner names. The two agreed on the files existing today, which is
     * exactly why the string-level check was worth writing: a future `connector-dummy-fixtures.test.ts`
     * would have kept running under `test.ts` while silently leaving the coverage measurement,
     * reproducing the original defect in a new file. Both scripts now declare the same named set.
     */
    const coverageNamed = coverageSource.match(/const\s+EXCLUDED_FILES\s*=\s*new Set\(\[([^\]]*)\]\)/)?.[1] ?? ''
    const coverageExclusions = [...coverageNamed.matchAll(/'([^']+)'/g)].map((m) => m[1]!)
    expect(coverageExclusions).toEqual(namedIntegrationExclusions(runnerSource))
    // And the SUFFIX rule must still be present on both sides — a set swap that dropped it would leave
    // `*.integration.test.ts` files measured while the runner refuses to run them (or vice versa).
    expect(coverageSource).toContain("endsWith('.integration.test.ts')")
  })
})
