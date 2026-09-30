/**
 * Row-cap completeness — the numeric spellings the FIRST fix still missed.
 *
 * Separate file from `guardrails.test.ts` because these are a different claim: that file pins the
 * bypasses named in the original defect report (`LIMIT ALL`, MySQL `LIMIT a, b`, `FETCH`/`TOP`
 * appending a bogus clause). Each case here was found by probing the SHIPPED function after that
 * fix landed, and each was MEASURED unbounded against a live PostgreSQL 16 before being clamped:
 *
 *   LIMIT 1.9e9                          the literal pattern required an INTEGER, so it matched only
 *                                        the `1`, wrote `LIMIT 1.9e9` back unchanged from inside its
 *                                        own "clamp", and returned all 500000 rows of the series.
 *   LIMIT 1000000.5e2                    same partial match: the `1000000` was rewritten and the
 *                                        `100.5e2` (10050 rows) it actually meant was left behind.
 *   FETCH FIRST 1000000 ROWS WITH TIES   a SECOND spelling of the FETCH clause, matched only in its
 *                                        `ONLY` form; returned all 500000 rows after ORDER BY.
 *
 * Those three are the reason the literal is now matched WHOLE and `WITH TIES` is folded into the
 * same rule — `WITH TIES` is rewritten to `ONLY` rather than renumbered, because ties ADD rows past
 * the count, so it cannot express a hard cap at all.
 *
 * Every assertion below drives `validateAndSanitizeLlmSql`, the SHIPPED path. A test that exercised
 * a helper nobody calls would pass while the bypass stayed live, which this repo has catalogued as
 * its own defect class ("a fix placed where it can never run").
 *
 * Scope note: a LEXICAL clamp, not a parser. The two shapes it deliberately does not bound are pinned
 * at the bottom as documented gaps rather than left to be rediscovered as bugs.
 */
import { describe, expect, test } from 'bun:test'
import { validateAndSanitizeLlmSql } from './guardrails'
import { SQL_MAX_LIMIT } from '@/lib/constants'

/** Sanitize, assert it passed, and strip the trailing `;` the guardrail always appends. */
function capped(sql: string): string {
  const r = validateAndSanitizeLlmSql(sql)
  expect(r.ok, `unexpected block: ${r.ok ? '' : r.reason}`).toBe(true)
  return r.sanitized.replace(/;\s*$/, '')
}

describe('row cap — a numeric count is matched WHOLE, never partially', () => {
  test('an exponent literal is clamped, not partially matched', () => {
    // The partial match is the defect: the old pattern saw `1` inside `1.9e9`, clamped `1` to `1`,
    // and reported success. Asserting the exact output catches that, because "clamped to itself"
    // and "clamped to the cap" differ by the digits left in the statement.
    expect(capped('SELECT id FROM orders LIMIT 1.9e9')).toBe('SELECT id FROM orders LIMIT 100')
    expect(capped('SELECT id FROM orders LIMIT 5e0')).toBe('SELECT id FROM orders LIMIT 5')
    expect(capped('SELECT id FROM orders LIMIT 1e10')).toBe('SELECT id FROM orders LIMIT 100')
  })

  test('a fractional count is clamped, not cut at the decimal point', () => {
    // `LIMIT 999999.9` previously became `LIMIT 100.9` — a number the model never wrote, still over
    // the cap. PostgreSQL accepts a fractional LIMIT (verified: `LIMIT 100.5` returns 101 rows).
    expect(capped('SELECT id FROM orders LIMIT 999999.9')).toBe('SELECT id FROM orders LIMIT 100')
    // The dangerous form: the tail after the decimal point is what makes the result large.
    expect(capped('SELECT id FROM orders LIMIT 1000000.5e2')).toBe('SELECT id FROM orders LIMIT 100')
  })

  test('a fractional count under the cap is left alone', () => {
    // The clamp must not fire on a value already inside it, and must not round it (`2.5` stays `2.5`).
    expect(capped('SELECT id FROM orders LIMIT 2.5')).toBe('SELECT id FROM orders LIMIT 2.5')
    expect(capped('SELECT id FROM orders LIMIT 99.9')).toBe('SELECT id FROM orders LIMIT 99.9')
  })

  test('the MySQL two-number form clamps whole numbers on both sides', () => {
    // Guards the `_`-separator and fractional paths through the (offset, count) rule specifically:
    // the offset is still preserved verbatim, the count is still what gets clamped.
    expect(capped('SELECT id FROM orders LIMIT 1_000_000, 2_000_000')).toBe(
      'SELECT id FROM orders LIMIT 1_000_000, 100',
    )
    expect(capped('SELECT id FROM orders LIMIT 1e5, 1e9')).toBe('SELECT id FROM orders LIMIT 1e5, 100')
  })

  test('MSSQL TOP clamps a whole numeric literal', () => {
    expect(capped('SELECT TOP 1e10 id FROM orders')).toBe('SELECT TOP 100 id FROM orders')
    expect(capped('SELECT TOP (999999.9) id FROM orders')).toBe('SELECT TOP (100) id FROM orders')
  })
})

describe('row cap — FETCH ... WITH TIES is a row limit too', () => {
  test('WITH TIES is capped, and becomes ONLY because ties exceed the count', () => {
    // MEASURED on PostgreSQL 16: `ORDER BY 1 FETCH FIRST 1000000 ROWS WITH TIES` returned all 500000
    // rows. Renumbering to `100 WITH TIES` would NOT cap it either — matching rows are appended past
    // the count — so the mode is rewritten. `ONLY` is the spelling that can honour a hard cap.
    expect(capped('SELECT id FROM orders ORDER BY id FETCH FIRST 1000000 ROWS WITH TIES')).toBe(
      'SELECT id FROM orders ORDER BY id FETCH FIRST 100 ROWS ONLY',
    )
    // Lowercase and `FETCH NEXT` reach the same rule. The clause keywords are matched
    // case-insensitively and the emitted mode is upper-case: SQL keywords are case-insensitive, so
    // normalizing here is harmless, and pinning it keeps the replacement text from drifting silently.
    expect(capped('SELECT id FROM orders ORDER BY id fetch next 1000000 rows with ties')).toBe(
      'SELECT id FROM orders ORDER BY id fetch next 100 rows ONLY',
    )
  })

  test('WITH TIES under the cap is still converted, but keeps its count', () => {
    // The count is legal, yet the clause still cannot bound rows the way `ONLY` does, so the mode
    // changes and the number does not. Asserted explicitly so a future "optimization" that skips
    // sub-cap clauses cannot silently restore the unbounded behaviour.
    expect(capped('SELECT id FROM orders ORDER BY id FETCH FIRST 5 ROWS WITH TIES')).toBe(
      'SELECT id FROM orders ORDER BY id FETCH FIRST 5 ROWS ONLY',
    )
  })

  test('plain FETCH FORMS are unaffected by the WITH TIES rule', () => {
    expect(capped('SELECT id FROM orders FETCH FIRST 1000000 ROWS ONLY')).toBe(
      'SELECT id FROM orders FETCH FIRST 100 ROWS ONLY',
    )
    expect(capped('SELECT id FROM orders FETCH NEXT 1000000 ROWS ONLY')).toBe(
      'SELECT id FROM orders FETCH NEXT 100 ROWS ONLY',
    )
    // `FETCH FIRST ROW ONLY` carries no count and is already bounded at one row.
    expect(capped('SELECT id FROM orders FETCH FIRST ROW ONLY')).toBe(
      'SELECT id FROM orders FETCH FIRST ROW ONLY',
    )
  })
})

describe('row cap — documented gaps, pinned so they stay visible', () => {
  test('an ARITHMETIC count is not bounded at this layer', () => {
    /*
     * `1000000*100` is an EXPRESSION, and deciding where it ends is parsing, not matching. This layer
     * still rewrites the leading number (so the output is `LIMIT 100*100`, i.e. 10000 rows — bounded,
     * but above the cap). Pinned as the ACTUAL behaviour so the limitation is recorded rather than
     * mistaken for an oversight, and so an improvement shows up as a test needing an update.
     */
    expect(capped('SELECT id FROM orders LIMIT 1000000*100')).toBe('SELECT id FROM orders LIMIT 100*100')
  })

  test('`TOP n PERCENT` below 100 is not a row count', () => {
    // A proportion needs the table's cardinality, which this layer never sees. `100 PERCENT` means
    // "every row", so it is the one spelling that should be capped; asserting the current output keeps
    // the gap honest either way.
    const out = capped('SELECT TOP 50 PERCENT id FROM orders')
    expect(out).toBe('SELECT TOP 50 PERCENT id FROM orders')
  })

  test('the cap itself is SQL_MAX_LIMIT, not a literal copied from this file', () => {
    // Every expectation above hard-codes 100. If the constant moves, this fails rather than silently
    // describing a cap the pipeline no longer applies.
    expect(SQL_MAX_LIMIT).toBe(100)
    expect(capped('SELECT id FROM orders LIMIT 1000000')).toBe('SELECT id FROM orders LIMIT 100')
  })
})
