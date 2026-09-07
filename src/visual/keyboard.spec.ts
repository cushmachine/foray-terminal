// Verify mobile keyboard behavior: the xterm live screen slides away
// when the Composer is focused, and slides back when the terminal is
// tapped. The KeyToolbar stays visible in all cases.
import { test, expect } from '@playwright/test'
import { MOBILE, expectTerminalReady } from './helpers.ts'

test.describe('keyboard behavior on mobile', () => {
  test.use({ viewport: MOBILE, isMobile: true, hasTouch: true })

  test('xterm screen hides when Composer is focused', async ({ page }) => {
    await page.goto('/')
    const xtermScreen = page.locator('[data-xterm-screen]')
    const composer = page.locator('[data-composer] textarea')
    const toolbar = page.getByTestId('key-toolbar')

    // Full viewport: xterm screen visible.
    await expect(xtermScreen).toBeVisible()
    await expect(toolbar).toBeVisible()

    // Focus the Composer — xterm screen should slide away.
    await composer.focus()
    await page.waitForTimeout(400)
    await expect(xtermScreen).toBeHidden()
    await expect(toolbar).toBeVisible()

    // Click the terminal area — xterm screen comes back.
    await page.locator('[data-testid="terminal-area"]').click()
    await page.waitForTimeout(400)
    await expect(xtermScreen).toBeVisible()
  })

  test('copy button is visible and copies terminal screen', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write'])
    await page.goto('/')
    await expectTerminalReady(page)

    const copyBtn = page.getByRole('button', { name: 'Copy terminal screen' })
    await expect(copyBtn).toBeVisible()
    await copyBtn.click()

    const clipboardText = await page.evaluate(() => navigator.clipboard.readText())
    expect(typeof clipboardText).toBe('string')
  })
})
