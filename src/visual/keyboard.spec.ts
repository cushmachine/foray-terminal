// Verify mobile keyboard behavior: the Composer hides when the terminal
// is focused and the layout shrinks, but stays when the Composer itself
// has focus. The KeyToolbar stays visible in all cases.
//
// A real keyboard isn't available in Playwright, so we simulate by shrinking
// the viewport (which changes visualViewport.height, triggers useAppHeight,
// and reduces --app-height — the same chain the real keyboard triggers).
import { test, expect } from '@playwright/test'
import { MOBILE, expectTerminalReady } from './helpers.ts'

test.describe('keyboard behavior on mobile', () => {
  test.use({ viewport: MOBILE, isMobile: true, hasTouch: true })

  test('Composer hides when layout shrinks and it is not focused', async ({ page }) => {
    await page.goto('/')
    const composer = page.locator('[data-composer]')
    const toolbar = page.getByTestId('key-toolbar')

    // Full viewport: both Composer and toolbar visible.
    await expect(composer).toBeVisible()
    await expect(toolbar).toBeVisible()

    // Simulate keyboard opening (terminal focused, not Composer).
    await page.setViewportSize({ width: MOBILE.width, height: 400 })
    await page.waitForTimeout(200)

    // Composer hides, toolbar stays.
    await expect(composer).toBeHidden()
    await expect(toolbar).toBeVisible()

    // Simulate keyboard closing.
    await page.setViewportSize(MOBILE)
    await page.waitForTimeout(200)
    await expect(composer).toBeVisible()
  })

  test('Composer stays visible when it has focus (even if layout shrinks)', async ({ page }) => {
    await page.goto('/')
    const composer = page.locator('[data-composer]')
    const textarea = composer.locator('textarea')

    // Focus the Composer textarea.
    await textarea.focus()
    await expect(textarea).toBeFocused()

    // Simulate keyboard opening while Composer is focused.
    await page.setViewportSize({ width: MOBILE.width, height: 400 })
    await page.waitForTimeout(200)

    // Composer stays because :focus-within is true.
    await expect(composer).toBeVisible()
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
