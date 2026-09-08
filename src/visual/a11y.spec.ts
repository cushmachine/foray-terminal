// Keyboard focus and accessible names.
//
// styles.css draws one :focus-visible ring for every control, and every
// icon button carries an aria-label; these keep both true.
import { test, expect, type Page } from '@playwright/test'
import { DESKTOP, MOBILE, openDrawer } from './helpers.ts'

async function expectEveryButtonNamed(page: Page): Promise<void> {
  const buttons = await page.getByRole('button').all()
  expect(buttons.length).toBeGreaterThan(0)
  for (const button of buttons) {
    await expect(button).toHaveAccessibleName(/\S/)
  }
}

test.describe('accessibility', () => {
  test.use({ viewport: DESKTOP })

  test('Tab to the first toolbar button shows a visible focus ring', async ({ page }) => {
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

  test('every button has an accessible name', async ({ page }) => {
    await page.goto('/')
    await expect(page.getByTestId('sidebar')).toBeVisible()
    // Open the file panel too so its header buttons are in the audit.
    await page.getByTestId('files-toggle').click()
    await expect(page.getByTestId('file-panel')).toBeVisible()
    await expectEveryButtonNamed(page)
  })
})

test.describe('accessibility on a phone', () => {
  test.use({ viewport: MOBILE, isMobile: true, hasTouch: true })

  test('every button has an accessible name: drawer, toolbar, files view', async ({ page }) => {
    await page.goto('/')
    await expect(page.getByTestId('key-toolbar')).toBeVisible()
    await expectEveryButtonNamed(page)
    await openDrawer(page)
    await expectEveryButtonNamed(page)
    await page.getByTestId('sidebar-close').click()
    await expect(page.getByTestId('sidebar')).toBeHidden()
    await page.getByRole('button', { name: 'files' }).click()
    await expect(page.getByTestId('file-panel')).toBeVisible()
    await expectEveryButtonNamed(page)
  })
})
