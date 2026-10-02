/**
 * Did the database actually answer the question, or should another source be tried?
 *
 * WHY THIS EXISTS. The router picks ONE source per question, and when two sources both talk about a topic it can
 * pick the wrong one. MEASURED over 526 document questions in an eval: 5.7% went to the database, and those were
 * concentrated on questions whose WORDS look like data ("berapa jam pelatihan per tahun … masa kerja di atas 3
 * tahun") while the ANSWER is a policy figure in a document. Once in the SQL branch there was no way back: the
 * outcome was "tidak dapat dihitung dari data yang tersedia" or, worse, a confident wrong number — "Total cuti
 * tahunan: 37 hari" from six leave requests, where the policy says 12.
 *
 * WHAT IS DECIDED HERE, AND WHAT IS NOT. This module only decides whether the rows are worth keeping. The caller
 * decides what to do next (try documents) and whether that is allowed (documents exist, the user did not pin a
 * database). Keeping the verdict a pure function of the rows is what makes it testable without a model.
 *
 * WHY NOT MATCH THE ANSWER TEXT. The obvious trigger — "the answer says it cannot be computed" — is a branch on
 * prose, which this codebase has repeatedly been bitten by (silent-failure class 10): the wording changes and the
 * match stops firing, with nothing reporting it. The signals below are read off the DATA instead.
 */

export type AnswerabilityVerdict =
  | { answers: true }
  | { answers: false; reason: 'no-rows' | 'all-null' | 'placeholder' | 'judged-irrelevant' }

/**
 * The generator has no sanctioned way to say "this schema cannot answer that", so when it is asked something the
 * schema does not hold it improvises one — MEASURED: `SELECT NULL::numeric AS "jam_pelatihan_per_tahun", 'Tidak
 * tersedia: skema tidak punya tabel pelatihan…' AS "keterangan"` and `SELECT 'TIDAK DAPAT DIJAWAB' AS "status", …`.
 * Those queries SUCCEED and return one row, so a row count alone reads them as an answer.
 */
const PLACEHOLDER_CELL = /\b(tidak\s+(dapat|bisa)\s+(dijawab|dihitung)|tidak\s+tersedia|tidak\s+ada\s+data|not\s+available|cannot\s+be\s+answered|no\s+data|n\/a|unavailable)\b/i

const isNumericString = (v: string): boolean => v.trim() !== '' && !Number.isNaN(Number(v))

/** A cell is a placeholder only when it is a short message, not a long free-text column that happens to say so. */
const PLACEHOLDER_MAX_LENGTH = 200

/**
 * Structural verdict, no model involved. `answers: true` means "not provably empty" — it is NOT a claim that the
 * rows are relevant; relevance is the optional judge's job and is only consulted when this returns true.
 */
export function judgeRowsStructurally(rows: ReadonlyArray<Record<string, unknown>>): AnswerabilityVerdict {
  if (rows.length === 0) return { answers: false, reason: 'no-rows' }

  const cells = rows.flatMap((row) => Object.values(row))
  if (cells.length === 0) return { answers: false, reason: 'no-rows' }

  // Every value empty: an aggregate over nothing (`SELECT SUM(x) …` with no matching rows) returns ONE row of NULL,
  // so a count of rows alone reports "1 row" for "no data".
  if (cells.every((v) => v === null || v === undefined || v === '')) return { answers: false, reason: 'all-null' }

  // The generator's improvised "I cannot answer": a literal message in place of data. DECIDED STRUCTURALLY ONLY when
  // the row cannot be carrying data at all — at least one cell is an "unavailable" message and EVERY non-empty cell
  // is a short non-numeric string (the message plus its label, e.g. status/keterangan). Any number, boolean or long
  // text is real data and keeps the rows.
  //
  // KNOWN LIMIT, stated rather than papered over: a short string cannot be told from a label by its shape, so a row
  // like {nama: 'Andi Pratama', catatan: 'tidak tersedia'} is judged a placeholder here. That is why a structural
  // "yes" is only a "not provably empty": the relevance judge, not this rule, is what decides populated rows, and a
  // wrong "placeholder" costs one extra retrieval rather than a wrong answer.
  const content = cells.filter((v) => v !== null && v !== undefined && v !== '')
  const isShortText = (v: unknown): v is string =>
    typeof v === 'string' && v.length <= PLACEHOLDER_MAX_LENGTH && !isNumericString(v)
  if (content.every(isShortText) && content.some((v) => PLACEHOLDER_CELL.test(v as string))) {
    return { answers: false, reason: 'placeholder' }
  }

  return { answers: true }
}

/**
 * Optional relevance judge, injected so tests can drive it. MEASURED on the eval set with the production model:
 * it said "answers" for 93% of genuine database questions, 19% of questions whose answer lives in a document, and
 * 0% of a question nothing could answer. That separation is why a "no" is trusted to trigger the fallback — and why
 * the fallback is merely a SECOND ATTEMPT rather than a replacement: a wrong "no" costs one extra retrieval, not a
 * wrong answer.
 */
export type RelevanceJudge = (question: string, rows: ReadonlyArray<Record<string, unknown>>) => Promise<boolean>

export async function judgeSqlAnswerability(args: {
  question: string
  rows: ReadonlyArray<Record<string, unknown>>
  judge?: RelevanceJudge
}): Promise<AnswerabilityVerdict> {
  const structural = judgeRowsStructurally(args.rows)
  if (!structural.answers) return structural
  if (!args.judge) return structural
  try {
    return (await args.judge(args.question, args.rows)) ? { answers: true } : { answers: false, reason: 'judged-irrelevant' }
  } catch {
    // A judge outage must not turn a working database answer into a fallback: keep the rows.
    return { answers: true }
  }
}
