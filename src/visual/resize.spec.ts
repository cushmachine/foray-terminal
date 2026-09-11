// Resizing a desktop window while a session prints.
//
// The desktop resizes the pty with the window; phones keep a fixed size
// (IS_TOUCH, CLAUDE.md), which is why every report of repeated and
// clipped lines has come from a desktop browser.
//
// What makes it fragile: the reader sees two stacked pieces of DOM. The
// scrollback pane holds tmux's history, and the xterm below it holds the
// visible screen. Nothing coordinates the seam between them — the pane
// only ever gains rows or is replaced wholesale. tmux, meanwhile, moves
// rows across that seam in both directions: a taller screen pulls lines
// back out of history, and a wider one re-wraps history into fewer rows
// and pulls lines up to fill the screen. Every line that crosses back is
// a line the pane still holds and the screen now draws again.
//
// Each test creates its own tmux session; the one active on load may be
// someone's live shell.
import { test, expect, type Page } from '@playwright/test'
import {
  DESKTOP,
  createSession,
  killSession,
  uniqueName,
  expectTerminalReady,
  expectTerminalText,
  sendKeys,
} from './helpers.ts'

/** 200 lines, each tagged with its own number, one screenful at a time. */
const PRINT_LINES = "for i in $(seq 1 200); do printf 'L%03d line\\n' $i; done\r"

/**
 * Every numbered line the reader can currently see, scrollback first and
 * the live screen after, in the order they appear down the page. A number
 * that shows up twice is a line drawn twice.
 */
async function visibleNumbers(page: Page): Promise<string[]> {
  const text = await page.evaluate(() => {
    const win = window as unknown as {
      __foray?: { term?: { rows: number; buffer: { active: { getLine(n: number): { translateToString(t?: boolean): string } | undefined } } } }
    }
    const pane = document.querySelector('[data-testid="terminal"] [data-testid="terminal-history"]')
    const history = pane ? Array.from(pane.children).map((row) => row.textContent ?? '') : []
    const term = win.__foray?.term
    const screen: string[] = []
    if (term) {
      for (let r = 0; r < term.rows; r++) screen.push(term.buffer.active.getLine(r)?.translateToString(true) ?? '')
    }
    return [...history, ...screen].join('\n')
  })
  return [...text.matchAll(/L(\d{3}) line/g)].map((m) => m[1])
}

/** The numbers that appear more than once, in order. */
function repeated(numbers: readonly string[]): string[] {
  const counts = new Map<string, number>()
  for (const n of numbers) counts.set(n, (counts.get(n) ?? 0) + 1)
  return [...counts].filter(([, c]) => c > 1).map(([n]) => n)
}

async function settle(page: Page): Promise<void> {
  // Long enough for a resize to reach tmux, tmux to redraw, and the
  // server's history check to run and answer.
  await page.waitForTimeout(2500)
}

test.describe('desktop resize', () => {
  test.use({ viewport: DESKTOP })

  test('a taller window does not draw scrollback lines twice', async ({ page }) => {
    const name = uniqueName('resize-tall')
    await page.goto('/')
    await createSession(page, name)
    try {
      await expectTerminalReady(page)
      await sendKeys(page, PRINT_LINES)
      await expectTerminalText(page, 'L200 line', 20_000)
      await settle(page)
      expect(repeated(await visibleNumbers(page)), 'before any resize').toEqual([])

      // Taller: tmux gives the screen back rows it had put in history.
      await page.setViewportSize({ width: DESKTOP.width, height: 1300 })
      await settle(page)
      expect(repeated(await visibleNumbers(page)), 'after growing the window').toEqual([])

      // And back, which pushes them into history again.
      await page.setViewportSize(DESKTOP)
      await settle(page)
      expect(repeated(await visibleNumbers(page)), 'after shrinking it back').toEqual([])
    } finally {
      await killSession(page, name)
    }
  })

  test('a wider window does not draw reflowed lines twice', async ({ page }) => {
    const name = uniqueName('resize-wide')
    await page.goto('/')
    await createSession(page, name)
    try {
      await expectTerminalReady(page)
      // Lines wider than the narrow pane, so widening really reflows them.
      await sendKeys(page, "for i in $(seq 1 120); do printf 'L%03d line %s\\n' $i \"$(printf 'x%.0s' $(seq 1 90))\"; done\r")
      await expectTerminalText(page, 'L120 line', 20_000)
      await settle(page)
      expect(repeated(await visibleNumbers(page)), 'before any resize').toEqual([])

      await page.setViewportSize({ width: 1900, height: DESKTOP.height })
      await settle(page)
      expect(repeated(await visibleNumbers(page)), 'after widening the window').toEqual([])

      await page.setViewportSize({ width: 900, height: DESKTOP.height })
      await settle(page)
      expect(repeated(await visibleNumbers(page)), 'after narrowing it').toEqual([])
    } finally {
      await killSession(page, name)
    }
  })
})

test.describe('desktop resize while output lands', () => {
  test.use({ viewport: DESKTOP })

  /**
   * The reported case: the window was dragged while a session was printing.
   * Lines three rows tall keep the history/screen boundary cutting through
   * the middle of a wrapped line, which is the one place tmux's history
   * changes after it is written — the captured part of that line grows as
   * its rows scroll up, and the server has to match against a line that is
   * no longer what it sent.
   */
  test('dragging the window mid-output does not repeat or split lines', async ({ page }) => {
    const name = uniqueName('resize-live')
    await page.goto('/')
    await createSession(page, name)
    try {
      await expectTerminalReady(page)
      // ~330 characters: three rows at the desktop width, more when narrow.
      await sendKeys(
        page,
        "for i in $(seq 1 150); do printf 'L%03d line %s\\n' $i \"$(printf 'y%.0s' $(seq 1 320))\"; sleep 0.15; done\r",
      )
      await page.waitForTimeout(2000)

      for (const size of [
        { width: 1900, height: 1200 },
        { width: 820, height: 700 },
        { width: 1500, height: 1000 },
        { width: 700, height: 1300 },
      ]) {
        await page.setViewportSize(size)
        await page.waitForTimeout(1800)
      }
      await page.setViewportSize(DESKTOP)
      await expectTerminalText(page, 'L150 line', 30_000)
      await settle(page)

      const numbers = await visibleNumbers(page)
      expect(repeated(numbers), 'lines drawn more than once').toEqual([])
      // Ordered, so nothing was spliced in from the wrong place.
      const backwards = numbers.findIndex((n, i) => i > 0 && n <= numbers[i - 1])
      expect(
        backwards,
        backwards < 0 ? '' : `out of order at ${backwards}: ${numbers.slice(Math.max(0, backwards - 2), backwards + 3).join(',')}`,
      ).toBe(-1)
    } finally {
      await killSession(page, name)
    }
  })
})
