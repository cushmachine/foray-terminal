// Mobile keyboard model: the pty is a fixed-size page and the soft keyboard
// is a curtain over it. Shrinking the viewport must never resize the
// terminal. Focus decides where the page is pinned: the Composer pins the
// last output row to the viewport bottom (prompt below the fold); the
// terminal pins to the true bottom (prompt visible). Only one input looks
// live at a time.
//
// Every test that sends input creates its own tmux session first; the
// session active on load may be someone's live shell.
import { test, expect, type Page } from '@playwright/test'
import {
  MOBILE,
  createSession,
  killSession,
  openDrawer,
  uniqueName,
  expectTerminalReady,
  expectTerminalText,
} from './helpers.ts'

type NestWindow = Window & { __nest?: { term?: { rows: number } } }

/** Rows of the active terminal, via the test hook Terminal.tsx exposes. */
async function termRows(page: Page): Promise<number> {
  return page.evaluate(() => (window as unknown as NestWindow).__nest?.term?.rows ?? 0)
}

// Every opened session keeps its terminal mounted (hidden); only the active
// one carries data-testid="terminal", so scope every lookup through it.
const active = (page: Page) => page.getByTestId('terminal')

async function xtermHeight(page: Page): Promise<number> {
  const box = await active(page).locator('[data-xterm-screen]').boundingBox()
  expect(box).not.toBeNull()
  return box!.height
}

/** Pixels of scroll content left below the viewport. 0 when pinned to the true bottom. */
async function scrollGap(page: Page): Promise<number> {
  return active(page).getByTestId('terminal-scroll').evaluate((el) => el.scrollHeight - (el.scrollTop + el.clientHeight))
}

/** Pixel height of one terminal row. */
async function cellHeight(page: Page): Promise<number> {
  return page.evaluate(() => {
    const rows = (window as unknown as NestWindow).__nest?.term?.rows ?? 0
    const screen = document.querySelector<HTMLElement>('[data-testid="terminal"] .xterm-screen')
    return rows > 0 && screen ? screen.clientHeight / rows : 0
  })
}

/**
 * How far the bottom of the screen row containing `text` sits above the
 * scroll viewport's bottom edge. 0 = exactly aligned; negative = clipped.
 */
async function rowAlignment(page: Page, text: string): Promise<number> {
  return page.evaluate((t) => {
    const term = document.querySelector<HTMLElement>('[data-testid="terminal"]')!
    const scroll = term.querySelector<HTMLElement>('[data-testid="terminal-scroll"]')!
    const rows = Array.from(term.querySelectorAll<HTMLElement>('.xterm-rows > div'))
    const row = rows.find((d) => d.textContent?.trim() === t)
    if (!row) return NaN
    return scroll.getBoundingClientRect().bottom - row.getBoundingClientRect().bottom
  }, text)
}

async function composerOpacity(page: Page): Promise<string> {
  return page.locator('[data-composer]').evaluate((el) => getComputedStyle(el).opacity)
}

/** Create a session through the mobile drawer, then close the drawer. */
async function createMobileSession(page: Page, name: string): Promise<void> {
  await openDrawer(page)
  await createSession(page, name)
  await page.getByTestId('sidebar-close').click()
  await expect(page.getByTestId('sidebar')).toBeHidden()
}

async function killMobileSession(page: Page, name: string): Promise<void> {
  await openDrawer(page)
  await killSession(page, name)
}

test.describe('keyboard behavior on mobile', () => {
  test.use({ viewport: MOBILE, isMobile: true, hasTouch: true })

  test('pty size is fixed across keyboard toggles', async ({ page }) => {
    await page.goto('/')
    const name = uniqueName('kb-fixed')
    try {
      await createMobileSession(page, name)
      await expectTerminalReady(page)
      const rows = await termRows(page)
      expect(rows).toBeGreaterThan(0)
      const height = await xtermHeight(page)

      // Keyboard up: the viewport shrinks, the page does not.
      await page.setViewportSize({ width: MOBILE.width, height: 400 })
      await page.waitForTimeout(400)
      expect(await termRows(page)).toBe(rows)
      expect(await xtermHeight(page)).toBeCloseTo(height, 0)

      // Keyboard down again.
      await page.setViewportSize(MOBILE)
      await page.waitForTimeout(400)
      expect(await termRows(page)).toBe(rows)
      expect(await xtermHeight(page)).toBeCloseTo(height, 0)
    } finally {
      await page.setViewportSize(MOBILE)
      await killMobileSession(page, name).catch(() => {})
    }
  })

  test('composer focus pins output above the fold; terminal focus pins to the bottom', async ({ page }) => {
    await page.goto('/')
    const name = uniqueName('kb-pin')
    try {
      await createMobileSession(page, name)
      await expectTerminalReady(page)

      // Keyboard up: the fixed-height page is taller than the viewport.
      await page.setViewportSize({ width: MOBILE.width, height: 500 })
      await page.waitForTimeout(400)

      // Fill the screen with output so the prompt sits below real content.
      await page.getByTestId('terminal-area').click()
      await page.evaluate(() => {
        window.dispatchEvent(new CustomEvent('nest:sendkeys', { detail: 'seq 1 80\r' }))
      })
      await expectTerminalText(page, '80')

      const cellH = await cellHeight(page)
      expect(cellH).toBeGreaterThan(0)

      // Composer: the last output row meets the viewport bottom, leaving
      // exactly the prompt row plus the 8px container padding under the fold.
      await page.locator('[data-composer] textarea').focus()
      await page.waitForTimeout(900) // let the smooth scroll land
      // "80" is the last output row: fully visible, flush with the fold.
      await expect.poll(() => rowAlignment(page, '80'), { timeout: 5_000 }).toBeGreaterThanOrEqual(-0.5)
      expect(await rowAlignment(page, '80')).toBeLessThanOrEqual(2)
      // And the prompt row is under the fold.
      expect(await scrollGap(page)).toBeGreaterThanOrEqual(cellH - 2)
      await page.screenshot({
        path: '/tmp/claude-0/-root-GitHub-lifeos/90a908dc-7c4b-4b6d-98cf-a7ba7a8162bd/scratchpad/kb-composer.png',
      })

      // Terminal: pinned to the true bottom, prompt visible.
      await page.getByTestId('terminal-area').click()
      await page.waitForTimeout(900)
      await expect.poll(() => scrollGap(page), { timeout: 5_000 }).toBeLessThan(4)
      await page.screenshot({
        path: '/tmp/claude-0/-root-GitHub-lifeos/90a908dc-7c4b-4b6d-98cf-a7ba7a8162bd/scratchpad/kb-terminal.png',
      })

      // Claude-Code-shaped screen: output, separator, a ❯ prompt row with
      // the cursor on it, and a status line under it. Composer mode must
      // park separator + prompt + status (+ the row after) below the fold.
      await page.evaluate(() => {
        window.dispatchEvent(new CustomEvent('nest:sendkeys', {
          detail: "printf 'LAST-OUTPUT\\n────────\\n❯ \\nSTATUS-LINE\\n\\033[2A'\r",
        }))
      })
      await expectTerminalText(page, 'STATUS-LINE')
      await page.locator('[data-composer] textarea').focus()
      await page.waitForTimeout(900)
      await expect.poll(() => rowAlignment(page, 'LAST-OUTPUT'), { timeout: 5_000 }).toBeGreaterThanOrEqual(-0.5)
      expect(await rowAlignment(page, 'LAST-OUTPUT')).toBeLessThanOrEqual(2)
      // separator + prompt + status (+ trailing row) parked below.
      expect(await scrollGap(page)).toBeGreaterThanOrEqual(4 * cellH - 2)
      await page.screenshot({
        path: '/tmp/claude-0/-root-GitHub-lifeos/90a908dc-7c4b-4b6d-98cf-a7ba7a8162bd/scratchpad/kb-composer-cc.png',
      })
      await page.getByTestId('terminal-area').click()
      await page.waitForTimeout(900)
      await expect.poll(() => scrollGap(page), { timeout: 5_000 }).toBeLessThan(4)
      await page.screenshot({
        path: '/tmp/claude-0/-root-GitHub-lifeos/90a908dc-7c4b-4b6d-98cf-a7ba7a8162bd/scratchpad/kb-terminal-cc.png',
      })
    } finally {
      await page.setViewportSize(MOBILE)
      await killMobileSession(page, name).catch(() => {})
    }
  })

  // Locking the phone or switching apps blurs the focused input and refocuses
  // it on return. That focus churn must not throw away a reader's place:
  // only a view already pinned to the bottom follows the pin.
  test('focus churn keeps a scrolled-up view where it was', async ({ page }) => {
    await page.goto('/')
    const name = uniqueName('kb-keep')
    const scroll = () => active(page).getByTestId('terminal-scroll')
    const scrollTop = () => scroll().evaluate((el) => el.scrollTop)
    try {
      await createMobileSession(page, name)
      await expectTerminalReady(page)

      // Keyboard up: the fixed-height page is taller than the viewport, so
      // there is somewhere to scroll to.
      await page.setViewportSize({ width: MOBILE.width, height: 500 })
      await page.waitForTimeout(400)
      await page.getByTestId('terminal-area').click()
      await page.evaluate(() => {
        window.dispatchEvent(new CustomEvent('nest:sendkeys', { detail: 'seq 1 80\r' }))
      })
      await expectTerminalText(page, '80')
      await page.locator('[data-composer] textarea').focus()
      await page.waitForTimeout(900)
      const pinned = await scrollTop()
      expect(pinned).toBeGreaterThan(100)

      // Scroll back up to read.
      const target = Math.round(pinned / 2)
      await scroll().evaluate((el, top) => { el.scrollTop = top }, target)
      await expect.poll(scrollTop).toBe(target)
      await page.waitForTimeout(100) // let the scroll event record the unpinned state

      // Sleep and wake: the composer blurs, then regains focus.
      const textarea = page.locator('[data-composer] textarea')
      await textarea.blur()
      await page.waitForTimeout(300)
      await textarea.focus()
      await page.waitForTimeout(900)
      expect(Math.abs((await scrollTop()) - target)).toBeLessThanOrEqual(2)

      // Output arriving while scrolled up does not pull the view down either.
      await page.evaluate(() => {
        window.dispatchEvent(new CustomEvent('nest:submit', { detail: 'echo AFTER-WAKE' }))
      })
      await expectTerminalText(page, 'AFTER-WAKE')
      await page.waitForTimeout(300)
      expect(Math.abs((await scrollTop()) - target)).toBeLessThanOrEqual(2)

      // Back at the bottom, the pin follows focus again: composer mode parks
      // the prompt row below the fold, terminal mode brings it back.
      await scroll().evaluate((el) => { el.scrollTop = el.scrollHeight })
      await page.waitForTimeout(100)
      await textarea.blur()
      await textarea.focus()
      await page.waitForTimeout(900)
      const cellH = await cellHeight(page)
      await expect.poll(() => scrollGap(page), { timeout: 5_000 }).toBeGreaterThanOrEqual(cellH - 2)
      await page.getByTestId('terminal-area').click()
      await expect.poll(() => scrollGap(page), { timeout: 5_000 }).toBeLessThan(4)
    } finally {
      await page.setViewportSize(MOBILE)
      await killMobileSession(page, name).catch(() => {})
    }
  })

  test('only one input looks live', async ({ page }) => {
    await page.goto('/')
    const name = uniqueName('kb-live')
    try {
      await createMobileSession(page, name)
      await expectTerminalReady(page)

      // Terminal focused: the Composer is dimmed.
      await page.getByTestId('terminal-area').click()
      await expect.poll(() => composerOpacity(page), { timeout: 5_000 }).toBe('0.55')

      // Composer focused: it is fully live.
      await page.locator('[data-composer] textarea').focus()
      await expect.poll(() => composerOpacity(page), { timeout: 5_000 }).toBe('1')
    } finally {
      await killMobileSession(page, name).catch(() => {})
    }
  })

  // Select mode: the toolbar's select key freezes scrollback plus screen as
  // plain text in an overlay the browser owns, so long-press selection works
  // (the live xterm rewrites its rows on every redraw, which kills a native
  // selection). Copy with nothing selected copies the whole snapshot; Done
  // returns to the live terminal.
  test('select key freezes the screen as selectable text; copy and done', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write'])
    await page.goto('/')
    const name = uniqueName('select-mode')
    try {
      await createMobileSession(page, name)
      await expectTerminalReady(page)
      await page.getByTestId('terminal-area').click()
      await page.evaluate(() => {
        window.dispatchEvent(new CustomEvent('nest:sendkeys', { detail: "printf 'select-me %s\\n' marker-42\r" }))
      })
      await expectTerminalText(page, 'select-me marker-42')

      const selectBtn = page.getByRole('button', { name: 'Select text' })
      await expect(selectBtn).toBeVisible()
      await selectBtn.click()

      const overlay = active(page).getByTestId('select-mode')
      await expect(overlay).toBeVisible()
      const text = overlay.getByTestId('select-mode-text')
      await expect(text).toContainText('select-me marker-42')
      await expect(text).toHaveCSS('user-select', 'text')
      // The keyboard drops: nothing in the composer or terminal has focus.
      expect(await page.evaluate(() => document.activeElement?.tagName ?? '')).not.toBe('TEXTAREA')

      await overlay.getByTestId('select-mode-copy').click()
      await expect.poll(() => page.evaluate(() => navigator.clipboard.readText()), { timeout: 5_000 })
        .toContain('select-me marker-42')
      await expect(overlay.getByTestId('select-mode-copy')).toContainText('Copied')

      await overlay.getByTestId('select-mode-done').click()
      await expect(overlay).toBeHidden()
      // Focus returns to the Composer so typing resumes.
      await expect(page.locator('[data-composer] textarea')).toBeFocused()
    } finally {
      await killMobileSession(page, name).catch(() => {})
    }
  })
})
