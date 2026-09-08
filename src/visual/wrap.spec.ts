// History wrapping on a phone, pending for S8.
//
// Symptom (screenshot 2026-09-08 13:36): the history pane wraps one column
// short of the pty width, so rows tmux already wrapped at `cols` wrap
// again in the browser and leave single-character orphan rows ("Eigh" /
// "t"). The pane must break lines at exactly the pty's column. fixme until
// S8 lands; S8 removes the fixme and runs it at 390x844 and 768x1024.
//
// Every test creates its own tmux session; the session active on load may
// be someone's live shell.
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

type NestWindow = Window & { __nest?: { term?: { cols: number } } }

/** A 196-character line with no spaces: wrap001wrap002...wrap028. */
const MARKER = 'wrap001'
const PRINT_LONG_LINE = "printf 'wrap%03d' $(seq 1 28); echo\r"

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

async function sendKeys(page: Page, data: string): Promise<void> {
  await page.getByTestId('terminal-area').click()
  await page.evaluate((d) => {
    window.dispatchEvent(new CustomEvent('nest:sendkeys', { detail: d }))
  }, data)
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
      let lastTop = NaN
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
          if (Math.abs(rect.top - lastTop) > 1) {
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

test.describe('history wrapping on a phone', () => {
  test.use({ viewport: MOBILE, isMobile: true, hasTouch: true })

  test.fixme('a long line in history wraps at the pty column with no orphan rows', async ({ page }) => {
    await page.goto('/')
    const name = uniqueName('wrap')
    try {
      await createMobileSession(page, name)
      await expectTerminalReady(page)
      await sendKeys(page, PRINT_LONG_LINE)
      await expectTerminalText(page, MARKER)

      // Push the line off the live screen into scrollback.
      await sendKeys(page, 'seq 1 80\r')
      await expectTerminalText(page, '80')
      await expect.poll(() => visualLines(page, MARKER).then((rows) => rows.length), { timeout: 10_000 })
        .toBeGreaterThan(0)

      const cols = await page.evaluate(() => (window as unknown as NestWindow).__nest?.term?.cols ?? 0)
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
    } finally {
      await killMobileSession(page, name).catch(() => {})
    }
  })
})
