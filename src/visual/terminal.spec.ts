// Terminal: AUDIT.md items 2, 17, 18.
import { test, expect } from '@playwright/test'
import { DESKTOP, createSession, expectTerminalReady, expectTerminalText, killSession, terminalScreen, uniqueName } from './helpers.ts'

test.use({ viewport: DESKTOP })

test('#2 the terminal renders with the WebGL renderer (a canvas) and exposes its buffer', async ({ page }) => {
  await page.goto('/')
  const name = uniqueName('webgl')
  try {
    await createSession(page, name)
    const terminal = page.getByTestId('terminal')
    await expect(terminal).toBeVisible()
    await expect(terminal.locator('canvas').first()).toBeVisible()
    await expectTerminalReady(page)
  } finally {
    await killSession(page, name).catch(() => {})
  }
})

test('#18 Shift+Enter reaches the program in the pane as CSI u, through tmux', async ({ page }) => {
  await page.goto('/')
  const name = uniqueName('shiftenter')
  try {
    await createSession(page, name)
    await expectTerminalReady(page)
    await page.getByTestId('terminal').click()
    await page.keyboard.type('cat -v')
    await page.keyboard.press('Enter')
    await expectTerminalText(page, 'cat -v')
    await page.keyboard.press('Shift+Enter')
    // cat -v prints ESC as ^[ ; a plain Enter would show nothing here.
    await expectTerminalText(page, '^[[13;2u')
    await page.keyboard.press('Control+c')
  } finally {
    await killSession(page, name).catch(() => {})
  }
})

test('#17 selecting text in the terminal puts it on the clipboard', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  await page.goto('/')
  const name = uniqueName('copy')
  const marker = `copytest${Date.now().toString(36)}`
  try {
    await createSession(page, name)
    await expectTerminalReady(page)
    await page.getByTestId('terminal').click()
    await page.keyboard.type(`echo ${marker}`)
    await page.keyboard.press('Enter')
    await expectTerminalText(page, marker)
    // Select the echoed line the way a drag or long-press would: through
    // xterm's selection, which fires the same selection-change event.
    const rows = await terminalScreen(page)
    const row = rows.findIndex((r, i) => r.trim() === marker && i > 0)
    expect(row).toBeGreaterThan(-1)
    await page.evaluate(({ row, len }) => {
      const term = (window as unknown as { __nest: { term: { select(c: number, r: number, l: number): void } } }).__nest.term
      term.select(0, row, len)
    }, { row, len: marker.length })
    await expect
      .poll(() => page.evaluate(() => navigator.clipboard.readText()), { timeout: 5_000 })
      .toBe(marker)
  } finally {
    await killSession(page, name).catch(() => {})
  }
})
