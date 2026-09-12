// History wrapping: the scrollback pane breaks lines where the pty does.
//
// Symptom this guards: the pane was a fraction of a cell narrower than the
// pty, so rows tmux or a program had already made exactly `cols` wide
// wrapped again in the browser and left single-character orphan rows
// ("Eigh" / "t"). The pane is now locked to exactly `cols` cells measured
// in its own font, and tmux's wrapped rows are captured joined so a long
// line is wrapped once, by the pane.
//
// Every test creates its own tmux session; the session active on load may
// be someone's live shell.
import { test, expect, type Page } from '@playwright/test'
import { wrapAtCols } from '../historyWidth.ts'
import {
  MOBILE,
  TABLET,
  createSession,
  killSession,
  openDrawer,
  uniqueName,
  expectTerminalReady,
  expectTerminalText,
  sendKeys as typeKeys,
} from './helpers.ts'

type ForayWindow = Window & { __foray?: { term?: { cols: number } } }

/** A 196-character line with no spaces: wrap001wrap002...wrap028. */
const MARKER = 'wrap001'
const PRINT_LONG_LINE = "printf 'wrap%03d' $(seq 1 28); echo\r"

/** A phone has a drawer to open; a tablet keeps the sidebar pinned. */
const usesDrawer = (page: Page): boolean => (page.viewportSize()?.width ?? 0) < 768

async function createOwnSession(page: Page, name: string): Promise<void> {
  if (!usesDrawer(page)) {
    await createSession(page, name)
    return
  }
  await openDrawer(page)
  await createSession(page, name)
  await page.getByTestId('sidebar-close').click()
  await expect(page.getByTestId('sidebar')).toBeHidden()
}

async function killOwnSession(page: Page, name: string): Promise<void> {
  if (usesDrawer(page)) await openDrawer(page)
  await killSession(page, name)
}

async function sendKeys(page: Page, data: string): Promise<void> {
  await page.getByTestId('terminal-area').click()
  await typeKeys(page, data)
}

async function termCols(page: Page): Promise<number> {
  return page.evaluate(() => (window as unknown as ForayWindow).__foray?.term?.cols ?? 0)
}

/**
 * The visual lines the browser laid out for every history row holding the
 * marker: one string per line box, found by grouping characters by the top
 * of their client rect. A row tmux split is one div; a row the browser
 * split is one div with several line boxes.
 */
async function visualLines(page: Page, marker: string): Promise<string[][]> {
  return page.evaluate((needle) => {
    const scroll = document.querySelector('[data-testid="terminal"] [data-testid="terminal-scroll"]')
    const history = scroll?.firstElementChild
    if (!history) return []
    const out: string[][] = []
    for (const row of Array.from(history.children)) {
      if (!(row.textContent ?? '').includes(needle)) continue
      const lines: string[] = []
      let lastTop: number | null = null
      const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT)
      let node: Node | null
      while ((node = walker.nextNode())) {
        const text = node as Text
        for (let i = 0; i < text.data.length; i++) {
          const range = document.createRange()
          range.setStart(text, i)
          range.setEnd(text, i + 1)
          const rect = range.getClientRects()[0]
          if (!rect) continue
          if (lastTop === null || Math.abs(rect.top - lastTop) > 1) {
            lines.push('')
            lastTop = rect.top
          }
          lines[lines.length - 1] += text.data[i]
        }
      }
      out.push(lines)
    }
    return out
  }, marker)
}

/** Print the long line and push it off the live screen into scrollback. */
async function fillHistory(page: Page): Promise<void> {
  await sendKeys(page, PRINT_LONG_LINE)
  await expectTerminalText(page, MARKER)
  await sendKeys(page, 'seq 1 80\r')
  await expectTerminalText(page, '80')
  await expect.poll(() => visualLines(page, MARKER).then((rows) => rows.length), { timeout: 10_000 })
    .toBeGreaterThan(0)
}

/** Every history row holding the marker is laid out exactly as a `cols`-wide pty shows it. */
async function expectWrappedAtPty(page: Page): Promise<void> {
  const cols = await termCols(page)
  expect(cols).toBeGreaterThan(0)
  const rows = await visualLines(page, MARKER)
  const lines = rows.flat()
  // No line box holds a lone character.
  expect(lines.filter((l) => l.trim().length === 1)).toEqual([])
  // Every full line is exactly the pty's width: the pane and the pty
  // agree on where a line breaks.
  const full = lines.filter((l) => l.length >= cols - 1)
  expect(full.length).toBeGreaterThan(0)
  for (const line of full) expect(line.length).toBe(cols)
  // And each row's line boxes are the rows tmux would have shown.
  for (const row of rows) expect(row).toEqual(wrapAtCols(row.join(''), cols))
  // The output line came joined: one row, however many line boxes.
  const output = rows.find((row) => row.join('').startsWith(MARKER))
  expect(output).toBeDefined()
  expect(output?.join('')).toBe(Array.from({ length: 28 }, (_, i) => `wrap${String(i + 1).padStart(3, '0')}`).join(''))
}

for (const [label, viewport, mobile] of [['a phone', MOBILE, true], ['a tablet', TABLET, false]] as const) {
  test.describe(`history wrapping on ${label}`, () => {
    test.use({ viewport, isMobile: mobile, hasTouch: mobile })

    test('a long line in history wraps at the pty column with no orphan rows', async ({ page }) => {
      await page.goto('/')
      const name = uniqueName('wrap')
      try {
        await createOwnSession(page, name)
        await expectTerminalReady(page)
        await fillHistory(page)
        await expectWrappedAtPty(page)
        // The live screen fits its container: nothing to scroll sideways to.
        const overflow = await page.getByTestId('terminal').getByTestId('terminal-scroll')
          .evaluate((el) => el.scrollWidth - el.clientWidth)
        expect(overflow).toBe(0)
      } finally {
        await killOwnSession(page, name).catch(() => {})
      }
    })
  })
}

// A resize changes the pty's columns and tmux reflows its history to the
// new width. The lines the client has are the same lines, so the pane keeps
// its rows (no reset, no jump) and merely wraps them at the new column.
test.describe('history across a resize', () => {
  // Wide enough that a narrower viewport still keeps the sidebar pinned.
  const WIDE = { width: 1000, height: 1024 }
  test.use({ viewport: WIDE })

  test('a narrower pty rewraps the pane without replacing its rows', async ({ page }) => {
    await page.goto('/')
    const name = uniqueName('reflow')
    const history = () => page.getByTestId('terminal').getByTestId('terminal-scroll').locator('> div:first-child')
    try {
      await createSession(page, name)
      await expectTerminalReady(page)
      await fillHistory(page)
      await expectWrappedAtPty(page)
      const colsBefore = await termCols(page)
      // Tag the row elements: a reset would replace them.
      await history().evaluate((el) => {
        for (const row of Array.from(el.children)) (row as HTMLElement).dataset.kept = '1'
      })
      const countBefore = await history().evaluate((el) => el.children.length)

      await page.setViewportSize({ width: 800, height: 1024 })
      await expect.poll(termCols.bind(null, page), { timeout: 10_000 }).toBeLessThan(colsBefore)
      await page.waitForTimeout(600) // the reflow check and any redraw settle
      await expectWrappedAtPty(page)
      const kept = await history().evaluate((el) =>
        Array.from(el.children).filter((row) => (row as HTMLElement).dataset.kept === '1').length)
      expect(kept).toBe(countBefore)
    } finally {
      await page.setViewportSize(WIDE)
      await killSession(page, name).catch(() => {})
    }
  })
})
