import { describe, expect, test } from 'bun:test'
import { isCorrect, percentile, QUESTIONS, regressions } from './latency-eval'

// The harness is the yardstick every latency change is judged by, so its own verdict logic is pinned:
// a grader that passes a wrong answer would let a faster-but-wrong pipeline look like a win.
describe('latency-eval grading', () => {
  test('accepts an answer containing any listed phrasing, case-insensitively', () => {
    expect(isCorrect('Cuti tahunan adalah 12 HARI kerja.', { any: ['12 hari'] })).toBe(true)
  })
  test('rejects an answer that states a different number', () => {
    expect(isCorrect('Cuti tahunan adalah 10 hari.', { any: ['12 hari'] })).toBe(false)
  })
  test('`all` is conjunctive: one of two required facts is not enough', () => {
    const q = { any: ['komite risiko'], all: ['2 hari'] }
    expect(isCorrect('Laporkan ke komite risiko.', q)).toBe(false)
    expect(isCorrect('Laporkan ke komite risiko dalam 2 hari kerja.', q)).toBe(true)
  })
  test('an empty answer is wrong for every question that expects content', () => {
    for (const q of QUESTIONS.filter((x) => x.any.some((s) => s.length > 0))) {
      expect(isCorrect('', q)).toBe(false)
    }
  })
  test('question ids are unique (a duplicate would hide one result behind another)', () => {
    expect(new Set(QUESTIONS.map((q) => q.id)).size).toBe(QUESTIONS.length)
  })
})

describe('latency-eval grading — questions the corpus cannot answer', () => {
  const q = (id: string) => QUESTIONS.find((x) => x.id === id)!
  test('an invented figure FAILS a question that has no answer', () => {
    expect(isCorrect('Gaji pokok direktur utama adalah Rp 50.000.000.', q('tidak-ada'))).toBe(false)
  })
  test('admitting the gap passes', () => {
    expect(isCorrect('Saya tidak menemukan informasi gaji direktur dalam dokumen.', q('tidak-ada'))).toBe(true)
  })
  test('a half-answerable question needs BOTH the known fact and the admission', () => {
    expect(isCorrect('Cuti tahunan 12 hari. Gaji direktur Rp 90 juta.', q('majemuk-separuh'))).toBe(false)
    expect(isCorrect('Cuti tahunan 12 hari.', q('majemuk-separuh'))).toBe(false)
    expect(isCorrect('Cuti tahunan 12 hari, tetapi gaji direktur tidak ditemukan.', q('majemuk-separuh'))).toBe(true)
  })
})

describe('percentile', () => {
  test('nearest-rank on a known set', () => {
    const v = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100]
    expect(percentile(v, 50)).toBe(50)
    expect(percentile(v, 95)).toBe(100)
  })
  test('does not mutate its input and tolerates empty input', () => {
    const v = [3, 1, 2]
    percentile(v, 50)
    expect(v).toEqual([3, 1, 2])
    expect(percentile([], 50)).toBe(0)
  })
})

describe('regressions', () => {
  const r = (id: string, ...c: boolean[]) => c.map((correct) => ({ id, correct }))
  test('a question right every time before and wrong once now IS a regression', () => {
    expect(regressions(r('q', true, true, true), r('q', true, false, true))).toEqual(['q (3/3 -> 2/3)'])
  })
  test('a question that was already flaky and stays equally flaky is not flagged', () => {
    expect(regressions(r('q', true, false, true), r('q', true, true, false))).toEqual([])
  })
  test('the rate is compared, so a different repeat count does not matter', () => {
    expect(regressions(r('q', true), r('q', true, true, true))).toEqual([])
    expect(regressions(r('q', true), r('q', true, false))).toEqual(['q (1/1 -> 1/2)'])
  })
  test('an improvement is never flagged, and a question missing from one run is skipped', () => {
    expect(regressions(r('q', false), r('q', true))).toEqual([])
    expect(regressions(r('a', true), r('b', false))).toEqual([])
  })
})
