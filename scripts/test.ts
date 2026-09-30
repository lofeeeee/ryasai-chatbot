#!/usr/bin/env bun
// ponytail: per-file subprocess runner — Bun's mock.module leaks across files
// in a single invocation (confirmed Bun 1.3.9; see ai.test.ts:5 comment).
// Each test file gets its own bun process for perfect mock isolation.
// Revert to `bun test src/` when Bun fixes mock.module cross-file isolation.

import { readFileSync } from 'node:fs'
import { parseBunSummary } from './test-summary'

/*
 * THE BUN VERSION IS CHECKED, because verifying on a different runtime than CI is a silent way to be wrong.
 *
 * MEASURED COST of not doing this: this repo pins `packageManager: bun@1.4.2` and `engines.bun >= 1.4.2`, CI pins
 * `bun-version: 1.4.2`, while the machine that produced this session's earlier measurements was running 1.3.14.
 * That mismatch produced a recorded "CI measures lower than local" offset which the gate file justified loosening
 * ten coverage floors by 5-10 points for. Running the SAME tree through BOTH versions showed the numbers are
 * IDENTICAL to the line (25093/33051 = 75.92% on each) — so the offset never existed, the baseline was stale, and
 * the loosening was justified by a misdiagnosis.
 *
 * A WARNING, not a hard failure: a contributor on a newer patch release should not be blocked, but they should know
 * that "it passes locally" was measured somewhere the gate does not run. CI is authoritative and always pins.
 */
function checkBunVersion(): void {
  const pinned = (() => {
    try {
      const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
        packageManager?: string
      }
      return pkg.packageManager?.split('@')[1] ?? null
    } catch {
      return null
    }
  })()
  if (!pinned) return
  const running = Bun.version
  if (running === pinned) return
  // A DIFFERENT MINOR is the case that bit us, so it is called out as such.
  const sameMinor = running.split('.').slice(0, 2).join('.') === pinned.split('.').slice(0, 2).join('.')
  console.warn(
    `[test] WARNING: running bun ${running} but package.json pins ${pinned}` +
      (sameMinor ? ' (same minor, different patch — usually fine)' : ' (DIFFERENT MINOR — CI pins this version)') +
      '.\n[test] CI pins it for a reason; re-run with the pinned version before trusting a comparison.',
  )
}

// Called at module scope so it runs before any test output can be mistaken for a
// clean verification. Cheap (one small file read) and it cannot fail the run.
checkBunVersion()

const CONCURRENCY = 8

// ponytail: integration tests need things this runner does not provision —
// connector-dummy wants a live Postgres holding a seeded `dummy_test` schema;
// mcp-install wants network plus a package download. Opt in with
// `bun run test:integration`. Name a file *.integration.test.ts to join them.
const INTEGRATION_FILES = new Set(['src/lib/connector-dummy.test.ts'])
const isIntegration = (f: string) => INTEGRATION_FILES.has(f) || f.endsWith('.integration.test.ts')

/**
 * THE collection pattern. `scripts/coverage.ts` carries the IDENTICAL string, and
 * `src/lib/test-runner-parity.test.ts` reads both files and fails if they ever differ.
 *
 * WHY A NAMED CONSTANT: the two runners drifted once already — this script was widened to
 * `{src,benchmark}` while `coverage.ts` kept `src/**`, so 13 benchmark test files RAN in CI but were
 * never part of the coverage measurement (`benchmark/arms/hybrid-fusion.test.ts` imports
 * `@/lib/rag-ranking`, which the gate floors at 80%, so that module was being measured without the
 * tests that exercise it). A named constant is what the guard can compare; an inline string literal
 * in a `for await` is not.
 */
const TEST_FILE_GLOB = '{src,benchmark,scripts}/**/*.test.{ts,tsx}'

// ponytail: unit tests must not depend on a developer's .env. Without this, every
// test touching crypto.ts (notifications, plugin-registry, vector-stores) failed
// with "Missing required env var: ENCRYPTION_SECRET_KEY" on a fresh checkout.
// A real value — .env or CI secret — still wins; this is only a fallback.
//
// DATABASE_URL gets the same fallback, for the same reason and by MEASUREMENT:
// `ci.yml` states "Unit suite needs no database" and sets no DATABASE_URL, but
// Prisma resolves `env("DATABASE_URL")` when the client is CONSTRUCTED, not when
// a query runs — so merely importing `db` is enough to throw
// "Environment variable not found: DATABASE_URL", and process.exit(101) kills
// the whole file. Three files fail that way on a fresh checkout and pass with
// any well-formed URL, including one pointing at a host that does not exist:
//   src/lib/unified-tools.test.ts          (imports db via plugin-selector)
//   src/lib/tool-branches.test.ts          (imports db)
//   src/lib/tool-branches-branches.test.ts (imports db)
// The host is deliberately unreachable. A dummy that CONNECTS would let a test
// silently depend on real rows; one that cannot connect fails at the query, which
// is the honest boundary — these are unit tests and they mock the layer anyway.
const TEST_ENV: Record<string, string> = {
  ...(process.env as Record<string, string>),
  ENCRYPTION_SECRET_KEY: process.env.ENCRYPTION_SECRET_KEY ?? 'deadbeef'.repeat(8),
  DATABASE_URL: process.env.DATABASE_URL ?? 'postgresql://unit:unit@127.0.0.1:1/unit_test_unreachable',
  // A SHORT LLM retry backoff, injected for exactly the reason the two fallbacks above exist: a
  // unit run must measure assertions, not production retry timing. Driving the retry ladder to
  // exhaustion otherwise sleeps the real (1+2+4) x 500 ms = 3500 ms.
  //
  // MEASURED: 11 tests in `src/lib/ai.test.ts` paid 3501-3523 ms each in `setTimeout` — 38.66 s of
  // that file's 38.84 s — and the file was the WHOLE suite's critical path: `time bun run test` was
  // 39.99 s, and raising CONCURRENCY 8 -> 16 -> 32 moved the total by under 0.8 s, which is the
  // signature of a critical path rather than a parallelism limit.
  //
  // 25 ms keeps the LADDER'S SHAPE (wait, then 2x, then 4x = 175 ms total) while removing the wait.
  // Attempt COUNTS are untouched: the assertions are `toHaveBeenCalledTimes(3)`-shaped, so
  // shortening the base is assertion-neutral. Verified before the change by
  // `grep -rn "backoff\|BACKOFF" src/lib/llm-client.test.ts src/lib/ai.test.ts` -> exit 1 (no
  // match): no test asserts the DURATION. The production default stays 500 in
  // `src/lib/constants.ts`, which is where this variable is read; an explicit ambient value still
  // wins, so an operator can raise the real number and this fallback will not overwrite it.
  LLM_RETRY_BACKOFF_BASE_MS: process.env.LLM_RETRY_BACKOFF_BASE_MS ?? '25',
}

// Set to the EMPTY STRING, which is the only form that actually works. Bun does not override
// an env var that is already present, so an empty value here beats `.env` in the child.
// MEASURED, all three attempts, same probe reading `process.env.LLM_ALLOWED_HOSTS`:
//   - `delete TEST_ENV[key]`          → child re-loaded `.env` → "127.0.0.1"  (still leaks)
//   - `--no-env-file` on the spawn    → unreliable for `bun test`             (still leaks)
//   - `LLM_ALLOWED_HOSTS: ''`         → wins over `.env`                      (unset, effectively)
// Same effect as running with `env LLM_ALLOWED_HOSTS=` by hand, which was what proved the
// cause in the first place.
//
// WHY THIS MATTERS: `LLM_ALLOWED_HOSTS` changes the DEFAULT SECURITY POSTURE of
// `isBlockedHost()`. Adding the documented `LLM_ALLOWED_HOSTS=127.0.0.1` to `.env` so an
// install can reach a self-hosted embedding server on loopback turned six security test
// files red — every one of them asserting the default, none of them about that setting.
//
// Tests that exercise the allowlist SET it themselves, which still works: only the ambient
// value is suppressed. `ENCRYPTION_SECRET_KEY` and `DATABASE_URL` keep the explicit
// fallbacks above, which is what keeps the suite runnable on a fresh checkout.
for (const key of ['LLM_ALLOWED_HOSTS', 'LLM_ALLOW_BLOCKED_HOSTS', 'E2E_TEST_MODE']) {
  if (TEST_ENV[key] !== undefined) TEST_ENV[key] = ''
}

const runIntegration = process.argv.includes('--integration')
const files: string[] = []
// ponytail: `benchmark/` is globbed as well as `src/`. It was previously excluded,
// so `benchmark/*.test.ts` never ran in CI — meaning the eval harnesses, the
// artifacts most likely to be quoted as findings, were the one thing with no
// automated check. Both benchmark test files are fully mocked (no live Postgres,
// no network, no cognee server), so this costs one subprocess each.
//
// `.tsx` IS INCLUDED, and this was a real hole rather than a nicety: the glob used to be
// `**/*.test.ts`, which does NOT match `.test.tsx`. MEASURED: `cognee-diagnostics-render.test.tsx` was
// collected by nothing and had NEVER RUN in CI. A component test that never runs is worse than no test —
// it looks like coverage of a surface nothing checks. `scripts/coverage.ts` globs the same narrow pattern,
// so such a file does not even show up as missing there.
//
// `scripts/` IS INCLUDED for the same reason, and it was the third instance of this shape:
// `scripts/test-runner.test.ts` unit-tests this runner's own summary parser and had NEVER RUN, because
// no glob covered the directory it lives in. The accounting confirmed it exactly — 303 files on disk
// minus the 3 integration exclusions is 300, the number this runner printed, so that one file was the
// only thing missing.
//
// THE GLOB IS ONE STRING IN TWO SCRIPTS, which is how it drifted before: `coverage.ts` kept the old
// `src/**` form while this one was widened, so 13 benchmark files ran in CI but were never measured.
// `scripts/coverage.ts` now carries the IDENTICAL pattern, and `src/lib/test-runner-parity.test.ts`
// fails if the two ever disagree or if the collected set stops matching the files on disk.
for await (const f of new Bun.Glob(TEST_FILE_GLOB).scan()) {
  if (isIntegration(f) !== runIntegration) continue
  files.push(f)
}
files.sort()

let totalPass = 0, totalFail = 0, totalSkip = 0, done = 0
const failed: string[] = []
const queue = [...files]

async function worker() {
  while (queue.length) {
    const path = queue.shift()!
    const proc = Bun.spawn(['bun', 'test', path], { stdout: 'pipe', stderr: 'pipe', env: TEST_ENV })
    const [code, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])
    const out = stdout + stderr
    // Read the counts from the SUMMARY LINE only, never from the whole output.
    // `out.match(/(\d+)\s+fail/)` takes the FIRST match anywhere, so a PASSING
    // test whose name contains the pattern poisons the total: the test
    // "exactly 10 runs with 8 failures trips the breaker" prints
    // "(pass) … 8 failures …", which was counted as 8 failing tests while the
    // exit code stayed 0. The runner thus reported "2369 pass · 8 fail" on a
    // fully green suite. A wrong failure count is worse than no count — it
    // trains everyone to ignore the number.
    // Counts come from scripts/test-summary.ts, which is unit-tested in
    // test-runner.test.ts. The `skip` count was silently ZERO for as long as this runner
    // has existed: Bun prints `pass` / `skip` / `fail` on separate lines, and the code here
    // used to read only the `pass` line, so `skip` could never match — 54 skipped tests
    // reported as "0 skip". See that module for the full account.
    const { pass: parsedPass, fail: parsedFail, skip: parsedSkip } = parseBunSummary(out)
    totalPass += parsedPass
    totalFail += parsedFail
    totalSkip += parsedSkip
    done++
    if (code !== 0) {
      // A non-zero exit with a parsed failure count of 0 means the summary line
      // was never printed (the process died mid-run) or Bun omitted the `pass`
      // line. Counting that as zero failures made the totals CONTRADICT the file
      // list — CI printed "6691 pass · 0 fail" directly above "Failed files:",
      // which is exactly the kind of self-contradicting number this runner's own
      // comment warns trains people to ignore it. Floor it at 1 so the totals can
      // never disagree with the exit code.
      if (parsedFail === 0) totalFail += 1
      failed.push(path)
      console.log(`\nFAIL ${path}`)
      const lines = out.split('\n').filter(Boolean)
      if (lines.length === 0) {
        // A subprocess that dies BEFORE printing anything (OOM kill, a module-load
        // crash) produced no output, so the old report was a bare filename with no
        // explanation -- which is what made three intermittent failures this session
        // look like "flakes" that could not be diagnosed. Say explicitly that there
        // was NO output and report the code, so the two cases are distinguishable:
        // a real test failure always prints a "(fail)" line and a summary.
        console.log(`  (no output — process exited ${code} before printing anything)`)
      } else {
        for (const l of lines.slice(-25)) console.log('  ' + l)
      }
    } else {
      process.stdout.write('.')
    }
  }
}

await Promise.all(
  Array.from({ length: Math.min(CONCURRENCY, files.length) }, () => worker()),
)

console.log(`\n${done}/${files.length} files · ${totalPass} pass · ${totalFail} fail · ${totalSkip} skip`)
if (failed.length) {
  console.log('\nFailed files:')
  for (const f of failed) console.log('  ' + f)
  process.exit(1)
}

export {}
