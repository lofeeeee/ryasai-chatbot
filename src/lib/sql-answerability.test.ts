import { describe, expect, test } from 'bun:test'
import { judgeRowsStructurally, judgeSqlAnswerability } from '@/lib/sql-answerability'

/*
 * The verdict is a pure function of the rows, and that is the property worth guarding: the first design for this
 * fallback matched the ANSWER's wording ("tidak dapat dihitung"), which is a branch on prose — it stops firing the
 * moment the model rephrases, and nothing reports it. Every case below is a shape MEASURED from the production model
 * against an HR database, not an invented one.
 */
describe('judgeRowsStructurally', () => {
  test('no rows is not an answer', () => {
    expect(judgeRowsStructurally([])).toEqual({ answers: false, reason: 'no-rows' })
  })

  test('ONE row of NULL is not an answer, although the row count says 1', () => {
    // `SELECT SUM(x) …` over no matching rows returns exactly one row holding NULL.
    expect(judgeRowsStructurally([{ total: null }])).toEqual({ answers: false, reason: 'all-null' })
    expect(judgeRowsStructurally([{ a: null, b: '' }])).toEqual({ answers: false, reason: 'all-null' })
  })

  test("the generator's improvised 'cannot answer' rows are not an answer", () => {
    // MEASURED verbatim from the model when asked something the schema does not hold.
    expect(
      judgeRowsStructurally([{ jam_pelatihan_per_tahun: null, keterangan: 'Tidak tersedia: skema tidak punya tabel pelatihan' }]),
    ).toEqual({ answers: false, reason: 'placeholder' })
    expect(judgeRowsStructurally([{ status: 'TIDAK DAPAT DIJAWAB', alasan: 'skema hanya berisi karyawan' }])).toEqual({
      answers: false,
      reason: 'placeholder',
    })
  })

  test('a real number next to a note is a real answer', () => {
    // The guard must not swallow a legitimate row that merely carries an explanatory column.
    expect(judgeRowsStructurally([{ total_hari: 130, catatan: 'data tidak tersedia untuk 2023' }])).toEqual({ answers: true })
    expect(judgeRowsStructurally([{ jumlah_karyawan: '3' }])).toEqual({ answers: true })
  })

  test('a boolean or date beside a note is real data', () => {
    expect(judgeRowsStructurally([{ aktif: true, catatan: 'tidak tersedia' }])).toEqual({ answers: true })
    expect(judgeRowsStructurally([{ tanggal: new Date('2024-01-02'), catatan: 'tidak tersedia' }])).toEqual({ answers: true })
  })

  test('KNOWN LIMIT: a short NAME beside a note cannot be told from a label, and is judged a placeholder', () => {
    // Pinned on purpose so the limit is visible. A short string is a label or a value depending on meaning, which a
    // structural rule cannot see; the relevance judge exists for populated rows, and a wrong "placeholder" costs one
    // extra retrieval, never a wrong answer. Do not "fix" this by widening the rule — fix it with the judge.
    expect(judgeRowsStructurally([{ nama: 'Andi Pratama', catatan: 'data tidak tersedia untuk 2023' }])).toEqual({
      answers: false,
      reason: 'placeholder',
    })
  })

  test('a long free-text cell that happens to contain the phrase is not mistaken for a placeholder', () => {
    const longNote = 'Dokumen ini membahas banyak hal. '.repeat(10) + 'Informasi tidak tersedia untuk bagian tertentu.'
    expect(longNote.length).toBeGreaterThan(200)
    expect(judgeRowsStructurally([{ isi: longNote, id: 'abc' }])).toEqual({ answers: true })
  })

  test('populated, ordinary rows are not provably empty', () => {
    expect(judgeRowsStructurally([{ id: 1, nama: 'Andi', jabatan: 'Engineer' }])).toEqual({ answers: true })
  })
})

describe('judgeSqlAnswerability — the optional relevance judge', () => {
  const rows = [{ id: 1, nama: 'Andi' }]

  test('the judge is NOT consulted when the rows are already provably empty', async () => {
    let called = 0
    const v = await judgeSqlAnswerability({ question: 'q', rows: [], judge: async () => { called++; return true } })
    expect(v).toEqual({ answers: false, reason: 'no-rows' })
    expect(called).toBe(0)
  })

  test('a "no" from the judge falls back; a "yes" keeps the rows', async () => {
    expect(await judgeSqlAnswerability({ question: 'q', rows, judge: async () => false })).toEqual({ answers: false, reason: 'judged-irrelevant' })
    expect(await judgeSqlAnswerability({ question: 'q', rows, judge: async () => true })).toEqual({ answers: true })
  })

  test('a judge that THROWS keeps the rows — an outage must not discard a working database answer', async () => {
    const v = await judgeSqlAnswerability({ question: 'q', rows, judge: async () => { throw new Error('provider down') } })
    expect(v).toEqual({ answers: true })
  })

  test('with no judge, only the structural verdict applies', async () => {
    expect(await judgeSqlAnswerability({ question: 'q', rows })).toEqual({ answers: true })
  })
})
