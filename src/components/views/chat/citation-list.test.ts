/**
 * The citation badge must report the retrieval position, not the array position.
 *
 * UAT measured the defect this file pins: the best chunk of a four-document result was displayed as
 * "Match #3". The badge itself was never wrong about what it computed — it computed `idx + 1` — but
 * the array it indexed is not the retrieval list. `tool-router-agentic.ts` CONCATENATES the citations
 * of several tool runs, and `retrieveWithReflection` merges up to three retrieval expansions, so the
 * index a citation happens to occupy describes the concatenation rather than the search.
 *
 * The repair put the position on the citation (`rank`, stamped where the order is final) and made the
 * badge prefer it. `src/lib/chat-layout.test.ts` pins the preference; this file pins that the VIEW
 * actually passes the field, because a rank the caller never forwards is a rank nobody sees.
 *
 * WHY A SOURCE GUARD, and why `.test.ts`: the view uses `useState` and Radix `Collapsible`, so a
 * render guard would need a DOM harness; the failure mode being guarded is precisely "the wrong
 * arguments are passed", which is visible in the source and nowhere else. `.test.ts` is required —
 * `scripts/test.ts` collects `{src,benchmark}/**\/*.test.ts` and the glob does NOT match `.test.tsx`
 * (MEASURED: `cognee-diagnostics-render.test.tsx` never appears in the runner's file set). A guard
 * the runner cannot see reports safety.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { citationRankLabel } from '@/lib/chat-layout'

const VIEW = join(import.meta.dir, 'citation-list.tsx')
const viewSrc = readFileSync(VIEW, 'utf-8')

/**
 * Comments stripped, so an assertion can never be satisfied by the FIX'S OWN NOTES quoting the old code.
 *
 * The comment above the call in this very view explains why `c.rank` is preferred and would otherwise
 * contain the exact strings asserted below — the guard would then pass with the call reverted.
 */
const strip = (s: string) =>
  s
    .split('\n')
    .map((l) => {
      const t = l.trimStart()
      if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return ''
      const i = l.indexOf('//')
      return i === -1 ? l : l.slice(0, i)
    })
    .join('\n')

const code = strip(viewSrc)

describe('chat citation list — the badge is given the retrieval rank', () => {
  test('passes the citation rank into the label helper', () => {
    // The three-argument call, with `idx` present as the fallback for older citations that carry none.
    expect(code).toContain('citationRankLabel(idx, c.score, c.rank)')
  })

  test('no two-argument call survives — that is the reverted shape', () => {
    // Anchored on the CLOSING paren: a naive `toContain('citationRankLabel(idx, c.score')` is also
    // satisfied by the correct three-argument call, so it could never fail.
    const reverted = /citationRankLabel\(\s*idx\s*,\s*c\.score\s*\)/
    expect(reverted.test(code)).toBe(false)
  })

  test('the helper is imported, not re-implemented locally', () => {
    // A local copy with the right name would satisfy the string assertions above while diverging
    // from the tested helper the moment either side changes.
    expect(code).toContain("from '@/lib/chat-layout'")
    expect(code).not.toMatch(/function\s+citationRankLabel\b/)
  })

  test('the computed label is actually rendered', () => {
    // Computing the rank and discarding it would leave the badge absent entirely — a silent
    // regression that no assertion about the call site would catch.
    expect(code).toContain('{rankLabel !== null &&')
    expect(code).toContain('{rankLabel}')
  })

  test('what the user sees: a rank-carrying citation is labelled by its match position', () => {
    // The end-to-end meaning of the wiring above, through the REAL helper. Before the fix the view
    // called `citationRankLabel(idx, c.score)`, so a citation sitting first in the array but third in
    // the retrieval read "Match #1" — the exact mislabel UAT reported.
    expect(citationRankLabel(0, 0.0328, 3)).toBe('Match #3')
    expect(citationRankLabel(0, 0.0328)).toBe('Match #1')
    // A DATABASE citation has no match position and no score, so it gets no badge.
    expect(citationRankLabel(0, undefined, 3)).toBeNull()
  })
})
