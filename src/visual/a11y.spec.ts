// Keyboard focus and accessible names, pending for S9.
//
// Buttons are styled inline with `outline: none` and nothing replaces the
// focus ring, so a keyboard user cannot see where they are; several icon
// buttons have no accessible name at all. fixme until S9 lands; S9 removes
// the fixme.
import { test, expect } from '@playwright/test'
import { DESKTOP } from './helpers.ts'

test.describe('accessibility', () => {
  test.use({ viewport: DESKTOP })

  test.fixme('Tab to the first toolbar button shows a visible focus ring', async ({ page }) => {
    await page.goto('/')
    await expect(page.getByTestId('sidebar')).toBeVisible()
    // Start from the document so Tab lands on the first focusable control.
    await page.locator('body').click({ position: { x: 1, y: 1 } })
    await page.keyboard.press('Tab')
    const focused = page.locator(':focus')
    await expect(focused).toHaveJSProperty('tagName', 'BUTTON')
    const ring = await focused.evaluate((el) => {
      const style = getComputedStyle(el)
      return {
        outlineStyle: style.outlineStyle,
        outlineWidth: parseFloat(style.outlineWidth),
        boxShadow: style.boxShadow,
      }
    })
    const hasOutline = ring.outlineStyle !== 'none' && ring.outlineWidth > 0
    const hasShadow = ring.boxShadow !== 'none'
    expect(hasOutline || hasShadow, `no visible focus ring: ${JSON.stringify(ring)}`).toBe(true)
  })

  test.fixme('every button has an accessible name', async ({ page }) => {
    await page.goto('/')
    await expect(page.getByTestId('sidebar')).toBeVisible()
    // Open the file panel too so its header buttons are in the audit.
    await page.getByTestId('files-toggle').click()
    await expect(page.getByTestId('file-panel')).toBeVisible()

    const buttons = await page.getByRole('button').all()
    expect(buttons.length).toBeGreaterThan(0)
    for (const button of buttons) {
      await expect(button).toHaveAccessibleName(/\S/)
    }
  })
})
