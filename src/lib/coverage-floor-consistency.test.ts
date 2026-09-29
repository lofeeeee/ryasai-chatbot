import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * A coverage floor carries a comment quoting the measurement it was derived from:
 *
 *     'src/lib/tool-branches.ts': 73, // re-measured 73.76% (669/907); was 82
 *
 * MEASURED PROBLEM: 8 of 23 of those comments were STALE. `src/lib/rag-retrieval.ts` claimed
 * 70.79% (366/517) while the merged measurement was 62.72% (387/617) — the file had gained 100 lines since the
 * comment was written, and `src/lib/tool-router.ts` claimed 62.62% against an actual 54.44%. Those comments exist
 * precisely so the next person can judge whether a floor is still calibrated; a stale one is worse than none,
 * because it looks like evidence and answers the question wrongly.
 *
 * WHY THIS IS A TEST AND NOT A LINT: the numbers are only checkable against `coverage-summary.json`, which is a
 * refreshed artifact. `scripts/coverage.ts` regenerates it, so this assertion measures the floors against the
 * measurement on disk and fails when they drift apart by more than rounding.
 *
 * WHY THE TOLERANCE IS 0.05 AND EXACT COUNTS: the percentage is rounded to two decimals in the comment, so a tiny
 * float difference is expected and meaningless; the `hit/found` counts are exact integers and must match, because
 * a mismatch there means the file changed size — the actual signal that a floor needs re-deriving.
 */
const GATE = join(import.meta.dir, '..', '..', 'scripts', 'coverage-gate.ts')
const SUMMARY = join(import.meta.dir, '..', '..', 'coverage-summary.json')

type Entry = { file: string; hit: number; found: number; pct: number }

function readSummary(): Map<string, Entry> {
  const raw = JSON.parse(readFileSync(SUMMARY, 'utf8')) as { files: Entry[] }
  return new Map(raw.files.map((e) => [e.file, e]))
}

function readFloors(): Array<{ file: string; floor: number; pct: number; hit: number; found: number }> {
  const src = readFileSync(GATE, 'utf8')
  const pat = /'([^']+\.tsx?)':\s*(\d+)\s*,\s*\/\/\s*re-measured\s+([0-9.]+)%\s*\((\d+)\/(\d+)\)/g
  return [...src.matchAll(pat)].map((m) => ({
    file: m[1]!, floor: Number(m[2]), pct: Number(m[3]), hit: Number(m[4]), found: Number(m[5]),
  }))
}

describe('coverage floors — the quoted measurement must match the measurement on disk', () => {
  test('the extracts actually find floors (a detector that matches nothing would pass forever)', () => {
    // Without this, a change to the comment FORMAT would silently turn the drift check off: zero floors parsed is
    // zero mismatches, which is the "guard that cannot fail" shape this repo keeps finding.
    const floors = readFloors()
    expect(floors.length).toBeGreaterThan(15)
  })

  test('no floor comment quotes a stale measurement', () => {
    const summary = readSummary()
    const stale: string[] = []
    for (const f of readFloors()) {
      const e = summary.get(f.file)
      if (!e) continue // a floor for a file the summary does not measure is a different problem, checked below
      if (e.hit !== f.hit || e.found !== f.found || Math.abs(e.pct - f.pct) > 0.05) {
        stale.push(
          `${f.file}: comment says ${f.pct}% (${f.hit}/${f.found}), measured ${e.pct.toFixed(2)}% (${e.hit}/${e.found})`,
        )
      }
    }
    expect(stale).toEqual([])
  })

  test('no floor sits above the measurement it guards', () => {
    // A floor above the real value fails every run; the gate reports this, but catching it here names the file
    // before the gate's aggregate message does.
    const summary = readSummary()
    const over: string[] = []
    for (const f of readFloors()) {
      const e = summary.get(f.file)
      if (!e) continue
      if (f.floor > e.pct) over.push(`${f.file}: floor ${f.floor}% > measured ${e.pct.toFixed(2)}%`)
    }
    expect(over).toEqual([])
  })

  test('every floor names a file the summary measures', () => {
    // A floor for a renamed or deleted module silently stops guarding anything — the gate would report it as
    // "gated module(s) at or above their floors" while the file it named is gone.
    const summary = readSummary()
    const missing = readFloors().filter((f) => !summary.has(f.file)).map((f) => f.file)
    expect(missing).toEqual([])
  })
})
