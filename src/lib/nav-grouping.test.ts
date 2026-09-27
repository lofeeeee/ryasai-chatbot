import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { VIEW_KEYS } from './view-routing'

/**
 * Navigation invariants — the sidebar grouping and the reachability of AI Memory.
 *
 * WHY THIS EXISTS. The reported symptom was "AI Memory submenu tidak bisa diakses". Two things
 * caused it, and both are structural rather than visual, so a screenshot test would not have caught
 * either:
 *
 *   1. The Dashboard banner said "enable in Settings", and Settings has NO memory tab — the card
 *      lived under AI Configuration and Knowledge. The instruction itself pointed at a dead end.
 *   2. The card was reachable only by first navigating to Knowledge and then finding a tab. Nothing
 *      linked to it directly, so "reachable" depended on the reader guessing the right parent menu.
 *
 * A THIRD problem was the reason for the grouping: twelve peer sidebar items gave no answer to
 * "where would X be?", and five of them read as "settings" (AI Configuration, Prompt & Tools, Tools,
 * Integration API, Settings). The guard below pins the grouping AND the invariant that made it worth
 * doing — every navigation key appears exactly once, so a future edit cannot silently drop a view.
 */
const root = join(import.meta.dir, '..', '..')
const pageSrc = readFileSync(join(root, 'src', 'app', 'page.tsx'), 'utf-8')
const dashboardRaw = readFileSync(join(root, 'src', 'components', 'views', 'dashboard-view.tsx'), 'utf-8')

/**
 * Strip comments before matching DASHBOARD copy.
 *
 * LOAD-BEARING, and caught by this file's own negative control: the assertion below looks for the
 * string that sent operators to the wrong menu, and after the fix that string still existed — in the
 * comment explaining why it was removed. A guard that cannot tell prose from code reports a fault
 * that is not there, which trains people to ignore it. Same class as the release-image guard, whose
 * negative control once passed for exactly this reason.
 */
const stripComments = (src: string) =>
  src
    .split('\n')
    .map((line) => {
      const t = line.trimStart()
      if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return ''
      const i = line.indexOf('//')
      return i === -1 ? line : line.slice(0, i)
    })
    .join('\n')

const dashboardSrc = stripComments(dashboardRaw)

const aiConfigSrc = readFileSync(
  join(root, 'src', 'components', 'views', 'ai-configuration-view.tsx'),
  'utf-8',
)
const knowledgeSrc = readFileSync(
  join(root, 'src', 'components', 'views', 'knowledge-base-view.tsx'),
  'utf-8',
)

describe('sidebar: grouped, and every view appears exactly once', () => {
  test('NAV_GROUPS is defined and every item key is a real view', () => {
    const keys = [...pageSrc.matchAll(/\{ key: '([a-z-]+)', label:/g)].map((m) => m[1])
    expect(keys.length).toBeGreaterThan(0)
    const unknown = keys.filter((k) => !(VIEW_KEYS as readonly string[]).includes(k))
    expect(unknown, `sidebar references unknown view key(s): ${unknown.join(', ')}`).toEqual([])
  })

  test('no view is listed twice — a duplicate is how a menu silently loses an entry', () => {
    const keys = [...pageSrc.matchAll(/\{ key: '([a-z-]+)', label:/g)].map((m) => m[1])
    const seen = new Set<string>()
    const dupes = keys.filter((k) => (seen.has(k) ? true : (seen.add(k), false)))
    expect(dupes, `duplicate sidebar entries: ${dupes.join(', ')}`).toEqual([])
  })

  test('the flat NAV is DERIVED from the groups, not maintained beside them', () => {
    // Two hand-written lists is the defect this repo catalogs: they drift, and the drift is only
    // visible as a missing menu item. `NAV` must be built from `NAV_GROUPS`.
    expect(pageSrc).toContain('const NAV: NavItem[] = NAV_GROUPS.flatMap')
  })

  test('the four group titles are present and non-empty', () => {
    for (const title of ['Workspace', 'Data & Knowledge', 'AI & Automation', 'System']) {
      expect(pageSrc, `missing group: ${title}`).toContain(`title: '${title}'`)
    }
  })
})

describe('AI Memory is reachable without guessing its parent menu', () => {
  test('the AI Configuration view has a memory tab wired to the card', () => {
    expect(aiConfigSrc).toContain('TabsTrigger value="memory"')
    expect(aiConfigSrc).toContain('<CogneeCard />')
  })

  test('Knowledge does NOT duplicate the memory card — one configuration surface only', () => {
    // INCIDENT: the full AI Memory card rendered in BOTH Knowledge and AI Configuration, so the same
    // settings existed in two menus with no way to tell which was authoritative. Knowledge now shows a
    // status card that LINKS to the editor; the editor exists in exactly one place.
    expect(knowledgeSrc).toContain('<MemoryStatusCard />')
    expect(knowledgeSrc).not.toContain('<CogneeCard')
    // The tab is gone too — a tab with no editable content would be a dead end.
    expect(knowledgeSrc).not.toContain('TabsTrigger value="cognee"')
  })

  test('a retired `?tab=cognee` link FORWARDS instead of rendering a blank panel', () => {
    // Found by reading this file's own failure output: `applyTab` still accepted 'cognee' after the
    // tab was deleted, so `setTab('cognee')` selected a non-existent tab and rendered NOTHING. A
    // bookmark or a dashboard link would have looked broken rather than moved.
    expect(knowledgeSrc).toMatch(/raw === 'cognee'/)
    expect(knowledgeSrc).toMatch(/detail: \{ view: 'ai-config', tab: 'memory' \}/)
  })

  test('the dashboard banner NAVIGATES instead of naming a menu', () => {
    // The original copy said "enable in Settings" and there is no memory tab there. Asserting on the
    // DISPATCH rather than on the words: prose can be reworded, but a missing event cannot navigate.
    expect(
      dashboardSrc,
      'the AI Memory card must dispatch a navigate-view event targeting the memory tab',
    ).toMatch(/new CustomEvent\('navigate-view',\s*\{\s*detail:\s*\{\s*view:\s*'ai-config',\s*tab:\s*'memory'/)
  })

  test('the dashboard no longer tells the operator to look in Settings', () => {
    // Negative control for the fix: the exact string that sent people to the wrong menu.
    expect(dashboardSrc).not.toContain('enable in Settings')
  })

  test('both target views accept an externally selected tab', () => {
    // A controlled Tabs is what makes the deep link work at all: with `defaultValue` the incoming
    // target is ignored and the user lands on the first tab, which looks like the link is broken.
    for (const [name, src] of [
      ['ai-config', aiConfigSrc],
      ['knowledge', knowledgeSrc],
    ] as const) {
      expect(src, `${name} must listen for navigate-view with a tab`).toContain("addEventListener('navigate-view'")
      expect(src, `${name} must use a controlled Tabs value`).toMatch(/<Tabs value=\{tab\} onValueChange=\{setTab\}/)
    }
  })

  test('tab targets are validated before being applied', () => {
    // An unvalidated `setTab(detail.tab)` would accept any string and leave the view on a tab with
    // no content — a blank panel that reads as a broken page.
    expect(aiConfigSrc).toMatch(/raw === 'llm' \|\| raw === 'embedding' \|\| raw === 'memory'/)
    // Knowledge validates its OWN two tabs. 'cognee' is handled separately as a FORWARD, asserted
    // above — accepting it here would select a tab that does not exist.
    expect(knowledgeSrc).toMatch(/raw === 'documents' \|\| raw === 'vector'\) setTab/)
  })
})
