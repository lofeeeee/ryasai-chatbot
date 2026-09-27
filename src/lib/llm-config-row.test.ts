import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * ONE row resolver for the chat config, used by every path that reads or writes it.
 *
 * INCIDENT (user-reported): "setelah model dipilih lalu user pindah menu dan kembali. Model pilihan
 * kosong."
 *
 * MEASURED on the install: TWO `LlmConfig` rows existed —
 *
 *   purpose: 'chat'  → model `cbcn/deepseek-v4-flash`, `availableModels` EMPTY, never synced
 *   purpose: 'agent' → model `cbcn/deepseek-v4.1-flash`, `availableModels` = 37 entries, synced
 *
 * `getPublicLlmConfig()` (what the AI Configuration screen READS) used a bare `findFirst()`, while
 * `PUT` (what that screen WRITES) used `findFirst({ purpose: 'chat' })`. Postgres has no implicit
 * ORDER BY for an unfiltered `findFirst`, so which row the screen read was the planner's decision, not
 * the code's — and the read and write could land on different rows.
 *
 * The empty `availableModels` is the visible half: with no list, the screen renders a free-text Input
 * instead of a dropdown, so the "picked model" the user saw was text that had never been persisted.
 */
const libSrc = readFileSync(join(import.meta.dir, 'llm-config.ts'), 'utf-8')
const putSrc = readFileSync(join(import.meta.dir, '..', 'app', 'api', 'llm-config', 'route.ts'), 'utf-8')
const modelsSrc = readFileSync(join(import.meta.dir, '..', 'app', 'api', 'llm-config', 'models', 'route.ts'), 'utf-8')

/** Comments stripped — the fix's notes quote the OLD unfiltered call. */
const strip = (s: string) =>
  s
    .split('\n')
    .map((l) => {
      const t = l.trimStart()
      return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*') ? '' : l
    })
    .join('\n')

describe('llm config — the chat row is resolved in exactly one place', () => {
  test('the resolver filters on purpose, with a documented fallback', () => {
    const src = strip(libSrc)
    expect(src).toMatch(/export async function resolveChatConfigRow/)
    expect(src).toMatch(/findFirst\(\{ where: \{ purpose: 'chat' \} \}\)/)
  })

  test('getPublicLlmConfig uses the resolver, not a bare findFirst', () => {
    const src = strip(libSrc)
    const fn = src.slice(src.indexOf('export async function getPublicLlmConfig'))
    const body = fn.slice(0, fn.indexOf('const row = await resolveChatConfigRow()'))
    // The bare call must not appear in this function at all.
    expect(body).not.toMatch(/db\.llmConfig\.findFirst\(\)/)
    expect(fn).toMatch(/const row = await resolveChatConfigRow\(\)/)
  })

  test('the writer and the model-sync route use the SAME resolver', () => {
    // Read and write disagreeing is the defect; both must go through one function.
    expect(strip(putSrc)).toMatch(/resolveChatConfigRow\(\)/)
    expect(strip(modelsSrc)).toMatch(/resolveChatConfigRow\(\)/)
  })

  test('neither route resolves the row itself any more', () => {
    expect(strip(putSrc)).not.toMatch(/db\.llmConfig\.findFirst\(\{ where: \{ purpose: 'chat' \} \}\)/)
    expect(strip(modelsSrc)).not.toMatch(/const existing = await db\.llmConfig\.findFirst\(\)/)
  })
})

describe('model picker — a choice must survive navigation', () => {
  /**
   * The reported bug, second half. Even with the right row, the picker wrote only to LOCAL state:
   * `onValueChange={setModel}` staged the value and nothing sent it. Navigating away unmounted the view,
   * and the selection was never in the database to come back to — with no indication it was unsaved.
   *
   * The picker now persists immediately, and the failure path (a rejected write) keeps the value in the
   * control AND flags it, so a control never displays a value the server does not have.
   */
  const viewSrc = strip(
    readFileSync(join(import.meta.dir, '..', 'components', 'views', 'ai-configuration-view.tsx'), 'utf-8'),
  )

  test('the dropdown commits the choice instead of staging it', () => {
    expect(viewSrc).toMatch(/onValueChange=\{\(v\) => void persistModel\(v\)\}/)
    // The old bare setter is what staged the value forever.
    expect(viewSrc).not.toMatch(/onValueChange=\{setModel\}/)
  })

  test('a saved model is written with ONLY the model field', () => {
    // Sending the whole form would resend baseUrl / embeddingModel / keys from local state, so choosing
    // a model could overwrite a concurrent edit to another field.
    const fn = viewSrc.slice(viewSrc.indexOf('async function persistModel'))
    const body = fn.slice(0, fn.indexOf('async function handleFetchModels'))
    expect(body).toMatch(/body: JSON\.stringify\(\{ model: next \}\)/)
    expect(body).not.toMatch(/bodyUrl|baseUrl,/)
  })

  test('a FAILED write is surfaced and the value is not presented as saved', () => {
    const fn = viewSrc.slice(viewSrc.indexOf('async function persistModel'))
    const body = fn.slice(0, fn.indexOf('async function handleFetchModels'))
    // On failure the unsaved flag must remain set: clearing it would claim success.
    expect(body).toMatch(/setModelUnsaved\(true\)/)
    expect(body).toMatch(/setModelUnsaved\(false\)/)
    // And the user is told.
    expect(viewSrc).toMatch(/not saved yet/)
  })

  test('the free-text fallback commits on blur, not per keystroke', () => {
    // A PUT per character would persist half-typed names, which the runtime would then try to call.
    // Search from the LAST occurrence: the id appears first on SelectTrigger (the dropdown branch),
    // and a slice from there never reaches the Input. My first version measured the wrong branch and
    // failed against correct code.
    const at = viewSrc.lastIndexOf('id="llm-model"')
    expect(at).toBeGreaterThan(-1)
    const input = viewSrc.slice(at, at + 900)
    expect(input).toMatch(/onBlur=/)
    expect(input).toMatch(/void persistModel\(next\)/)
  })
})
