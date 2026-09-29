import { test, expect, type Page } from '@playwright/test'

/**
 * Sidebar reachability — measured geometry, not class names.
 *
 * WHY THIS FILE EXISTS. The user reported, with a screenshot at 1907x876 physical pixels, that the
 * navigation ended at "Integration API" and "Settings" was cut off, and asked for the rows to be
 * more compact. TWO fixes were attempted and both were wrong in the same way: they reasoned about
 * CSS classes instead of measuring the result.
 *
 *   1. `1094ac6` made the shell/nav scrollable. That is not the same as visible: measured in a real
 *      browser, the content still did not fit at the user's effective height, so "Settings" was
 *      below the fold and only reachable by scrolling a scrollbar the user never suspected.
 *   2. A later re-check concluded "not a live defect" by reading the class strings, and was
 *      overturned by the measured geometry.
 *
 * The unit test in `src/lib/nav-grouping.test.ts` pins the class strings, which is a WORD match: it
 * would stay green if the padding were reverted while some other rule compensated, and it cannot see
 * the viewport at all. `Silent-failure class #1` is exactly this — a guard matching a word, not a
 * call. So the real guard is here, in a browser, against a logged-in admin.
 *
 * WHAT IT PINS:
 *   - At the user's own effective viewports (1907x876 at 125-150% browser zoom), "Settings" — the
 *     entry an admin needs to manage their team — is inside the viewport with the nav UNSCROLLED.
 *     This is the distinction that made `1094ac6` insufficient, so it is asserted separately.
 *   - At EVERY height swept, every nav entry is REACHABLE: for each entry there exists a scroll
 *     position of the nav that brings it inside the nav box and inside the viewport.
 *
 * TWO MEASUREMENT TRAPS, both hit while writing this file; the comments below mark where.
 *   (a) Scrolling the nav to its END and then checking every entry marks the TOP entries
 *       unreachable — they have scrolled out of the box. The negative control caught this: it
 *       reported "Dashboard" (the first entry) unreachable at 1362x626, which is impossible. A guard
 *       that fails for the wrong reason is not a guard for the defect, so reachability is measured
 *       PER ENTRY, each after scrolling only that entry into view.
 *   (b) The nav box does not move when the nav scrolls (it is a fixed-height sticky shell), so its
 *       rect is captured once and reused; measuring it per entry would compare against a moving box.
 *
 * Runs against the shared e2e DB as admin@e2e.test, created by 01-setup-wizard (alphabetically
 * earlier). It only reads the shell — no rows are mutated.
 */

const E2E_EMAIL = 'admin@e2e.test'
const E2E_PASSWORD = 'password123'

/**
 * 1907x876 is the size of the user's screenshot in PHYSICAL pixels; CSS pixels depend on browser
 * zoom, so the three zoom levels that reproduce the report are listed first and explicitly. The rest
 * are ordinary laptop viewports, plus 620 which is the height the ORIGINAL clipping incident was
 * measured at (there the shell ended at y=620 while the nav inside it ended at y=669).
 */
const VIEWPORTS = [
  { w: 1362, h: 626, label: 'user screenshot @140% zoom' },
  { w: 1271, h: 584, label: 'user screenshot @150% zoom' },
  { w: 1526, h: 701, label: 'user screenshot @125% zoom' },
  { w: 1907, h: 620, label: 'original clipping incident' },
  { w: 1280, h: 720, label: 'common laptop' },
  { w: 1366, h: 768, label: 'common laptop' },
  { w: 1440, h: 900, label: 'common laptop' },
]

/** The heights at which "Settings" must be visible with NO scrolling at all. */
const MUST_FIT_WITHOUT_SCROLL = new Set([626, 584, 701, 720, 768, 900])

async function login(page: Page) {
  const res = await page.request.post('/api/auth/login', {
    data: { email: E2E_EMAIL, password: E2E_PASSWORD },
  })
  expect(res.ok(), 'admin login must succeed — 01-setup-wizard creates this account').toBeTruthy()
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible({ timeout: 15_000 })
}

type Entry = { label: string; reachable: boolean }

type Measurement = {
  found: boolean
  navTop: number
  navBottom: number
  navScrollH: number
  navClientH: number
  rowHeight: number
  settingsTop: number
  settingsBottom: number
  viewportH: number
  /** Settings inside the nav box AND the viewport with the nav at scrollTop 0. */
  visibleUnscrolled: boolean
  /** Every entry, in DOM order: can the nav bring it into view at all? */
  entries: Entry[]
}

async function measure(page: Page): Promise<Measurement> {
  return page.evaluate(() => {
    const nav = document.querySelector('nav') as HTMLElement | null
    if (!nav) throw new Error('no <nav> in the sidebar')

    const label = (b: HTMLButtonElement) => (b.textContent || '').trim()
    const buttons = (Array.from(nav.querySelectorAll('button')) as HTMLButtonElement[]).filter(
      (b) => label(b).length > 0,
    )
    const byLabel = (l: string) => buttons.find((b) => label(b) === l)
    const settings = byLabel('Settings')
    const dashboard = byLabel('Dashboard')

    // Anchor the measurement to the unscrolled state: the page may have been left scrolled by an
    // earlier iteration of the viewport sweep.
    nav.scrollTop = 0

    // TRAP (b): captured ONCE — the nav box is a fixed-height sticky shell, so it does not move when
    // its CONTENT scrolls. Re-reading it per entry would compare each entry against a moving box.
    const navRect = nav.getBoundingClientRect()
    const insideNavBox = (r: DOMRect) => r.top >= navRect.top - 1 && r.bottom <= navRect.bottom + 1
    const inViewport = (r: DOMRect) => r.top >= -1 && r.bottom <= window.innerHeight + 1

    const sRect = settings ? settings.getBoundingClientRect() : null
    const dRect = dashboard ? dashboard.getBoundingClientRect() : null
    const visibleUnscrolled = !!(sRect && insideNavBox(sRect) && inViewport(sRect))

    // TRAP (a): reachability is PER ENTRY. For each one, scroll the nav just enough to align that
    // entry with the top of the nav box (scrollTop clamps, so the last entries simply stop at the
    // end), then require it to be inside the nav box AND inside the viewport.
    //
    // If the nav is NOT the scroll container — the shape of the original incident, where the clip sat
    // on an ANCESTOR — assigning scrollTop does nothing, the entry never moves, and it fails here.
    const entries: Entry[] = buttons.map((b) => {
      const before = b.getBoundingClientRect()
      nav.scrollTop = nav.scrollTop + (before.top - navRect.top)
      const r = b.getBoundingClientRect()
      return { label: label(b), reachable: insideNavBox(r) && inViewport(r) }
    })

    return {
      found: !!settings,
      navTop: Math.round(navRect.top),
      navBottom: Math.round(navRect.bottom),
      navScrollH: nav.scrollHeight,
      navClientH: nav.clientHeight,
      rowHeight: dRect ? Math.round(dRect.height) : -1,
      settingsTop: sRect ? Math.round(sRect.top) : -1,
      settingsBottom: sRect ? Math.round(sRect.bottom) : -1,
      viewportH: window.innerHeight,
      visibleUnscrolled,
      entries,
    }
  })
}

function geometry(m: Measurement) {
  return (
    `nav box ${m.navTop}..${m.navBottom} (clientHeight ${m.navClientH}), ` +
    `content ${m.navScrollH}px, viewport ${m.viewportH}px, ` +
    `Settings ${m.settingsTop}..${m.settingsBottom}, row ${m.rowHeight}px`
  )
}

test.describe('sidebar — every menu stays REACHABLE at the reported viewport', () => {
  test('Settings is visible at the user-reported zoom, and every entry stays reachable', async ({
    page,
  }) => {
    await login(page)

    for (const vp of VIEWPORTS) {
      await page.setViewportSize({ width: vp.w, height: vp.h })
      // Let the shell's animated width settle so the measurement is of the final layout.
      await page.waitForTimeout(150)

      const m = await measure(page)
      const where = `${vp.w}x${vp.h} (${vp.label})`

      expect(m.found, `Settings entry missing from the nav at ${where}`).toBe(true)

      // Every entry, not just Settings: the report named Settings only because it is last.
      const unreachable = m.entries.filter((e) => !e.reachable).map((e) => e.label)
      expect(
        unreachable,
        `entries the nav cannot bring into view at ${where} — ${geometry(m)}. ` +
          `An entry that stays outside its own nav box no matter the scroll position means the ` +
          `clip is on an ANCESTOR, which is the original incident.`,
      ).toEqual([])

      if (MUST_FIT_WITHOUT_SCROLL.has(vp.h)) {
        expect(
          m.visibleUnscrolled,
          `Settings needs scrolling to be seen at ${where} — ${geometry(m)}. The fix for this ` +
            `report must make it VISIBLE, not merely scrollable; that distinction is exactly what ` +
            `made 1094ac6 insufficient and got it overturned.`,
        ).toBe(true)
      }
    }
  })

  test('the compacted rows leave headroom, so one more menu item cannot re-break the fold', async ({
    page,
  }) => {
    await login(page)
    await page.setViewportSize({ width: 1271, height: 584 })
    await page.waitForTimeout(150)

    const m = await measure(page)
    // 584 CSS px is the tightest viewport the user reported. Headroom is asserted rather than the
    // old numbers, so a future row tweak that eats the margin fails here instead of in a screenshot.
    const headroom = m.viewportH - m.settingsBottom
    expect(
      headroom,
      `only ${headroom}px of headroom below "Settings" at the user's tightest reported viewport — ` +
        `${geometry(m)}. A 13th menu entry would push it back below the fold.`,
    ).toBeGreaterThanOrEqual(8)
    // The row must still be a comfortable pointer target — compacting padding must not have shrunk
    // the clickable area toward the 24px minimum touch target.
    expect(m.rowHeight, 'nav rows must stay >= 28px tall').toBeGreaterThanOrEqual(28)
  })
})
