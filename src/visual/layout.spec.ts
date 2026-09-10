// Layout and chrome: top bar, panels and their toggles across viewports.
import { test, expect } from '@playwright/test'
import { DESKTOP, MOBILE, NARROW, TABLET, openDrawer } from './helpers.ts'

test.describe('key toolbar on desktop', () => {
  test.use({ viewport: DESKTOP })

  test('#10 is hidden by default, can be shown, and the choice persists', async ({ page }) => {
    await page.goto('/')
    const toolbar = page.getByTestId('key-toolbar')
    const toggle = page.getByTestId('keytoolbar-toggle')
    await expect(toolbar).toBeHidden()
    await expect(toggle).toBeVisible()
    await toggle.click()
    await expect(toolbar).toBeVisible()
    await page.reload()
    await expect(page.getByTestId('key-toolbar')).toBeVisible()
    await page.getByTestId('keytoolbar-toggle').click()
    await expect(page.getByTestId('key-toolbar')).toBeHidden()
  })
})

test.describe('key toolbar on a phone', () => {
  test.use({ viewport: MOBILE, isMobile: true, hasTouch: true })

  test('#10 is always shown on a touch viewport', async ({ page }) => {
    await page.goto('/')
    await expect(page.getByTestId('key-toolbar')).toBeVisible()
  })
})

test.describe('narrow phone', () => {
  test.use({ viewport: NARROW, isMobile: true, hasTouch: true })

  test('#5 the key toolbar hints that it scrolls, until scrolled to the end', async ({ page }) => {
    await page.goto('/')
    const row = page.getByTestId('key-toolbar-row')
    const fade = page.getByTestId('keytoolbar-fade-right')
    const overflows = await row.evaluate((el) => el.scrollWidth > el.clientWidth)
    expect(overflows).toBe(true)
    await expect(fade).toBeVisible()
    await row.evaluate((el) => { el.scrollLeft = el.scrollWidth })
    await expect(fade).toBeHidden()
  })
})

test.describe('tablet', () => {
  test.use({ viewport: TABLET })

  test('#6 sidebar and file panel do not both squeeze the terminal', async ({ page }) => {
    await page.goto('/')
    await expect(page.getByTestId('sidebar')).toBeVisible()
    await page.getByTestId('files-toggle').click()
    await expect(page.getByTestId('file-panel')).toBeVisible()
    // Opening the file panel on a tablet collapses the sidebar.
    await expect(page.getByTestId('sidebar')).toBeHidden()
    const terminal = await page.getByTestId('terminal-area').boundingBox()
    expect(terminal).not.toBeNull()
    expect(terminal!.width).toBeGreaterThanOrEqual(400)
    // And reopening the sidebar gives way the other direction.
    await page.getByTestId('sidebar-toggle').click()
    await expect(page.getByTestId('sidebar')).toBeVisible()
    await expect(page.getByTestId('file-panel')).toBeHidden()
  })
})

test.describe('file panel on a phone', () => {
  test.use({ viewport: MOBILE, isMobile: true, hasTouch: true })

  test('edit and close buttons are visible when a .md file is open', async ({ page }) => {
    await page.goto('/')
    // On mobile the view switcher has "term | files" buttons (no test ID).
    await page.getByRole('button', { name: 'files' }).click()
    await expect(page.getByTestId('file-panel')).toBeVisible()
    // Wait for the file tree to load, then tap a markdown file.
    const mdFile = page.getByTestId('file-panel').getByRole('button', { name: /\.md$/ }).first()
    await mdFile.click()
    // toBeVisible() is satisfied by an element rendered far off the right
    // edge, which is exactly the bug (an unwrapped long line widened the
    // panel), so also assert both buttons sit inside the viewport.
    const editBtn = page.getByTestId('file-edit-toggle')
    await expect(editBtn).toBeVisible()
    const editBox = await editBtn.boundingBox()
    expect(editBox).not.toBeNull()
    expect(editBox!.width).toBeGreaterThan(20)
    expect(editBox!.x + editBox!.width).toBeLessThanOrEqual(MOBILE.width)
    const closeBtn = page.getByTestId('file-panel').getByRole('button', { name: 'Close panel' })
    await expect(closeBtn).toBeVisible()
    const closeBox = await closeBtn.boundingBox()
    expect(closeBox).not.toBeNull()
    expect(closeBox!.width).toBeGreaterThan(10)
    expect(closeBox!.x + closeBox!.width).toBeLessThanOrEqual(MOBILE.width)
    const panel = await page.getByTestId('file-panel').boundingBox()
    expect(panel!.width).toBeLessThanOrEqual(MOBILE.width)
  })
})

test.describe('text fields on a phone', () => {
  test.use({ viewport: MOBILE, isMobile: true, hasTouch: true })

  // iOS zooms the page when a field under 16px takes focus, and the zoom
  // does not undo itself on blur.
  test('the Composer, the rename field and the editor use a 16px font', async ({ page }) => {
    await page.goto('/')
    const fontSize = (selector: string) =>
      page.locator(selector).first().evaluate((el) => getComputedStyle(el).fontSize)
    expect(await fontSize('[data-composer] textarea')).toBe('16px')

    await openDrawer(page)
    await page.getByTestId('session-rename').first().click()
    const input = page.getByTestId('session-name-input')
    await expect(input).toBeVisible()
    expect(await fontSize('[data-testid="session-name-input"]')).toBe('16px')
    await input.press('Escape')
    await page.getByTestId('sidebar-close').click()
    await expect(page.getByTestId('sidebar')).toBeHidden()

    await page.getByRole('button', { name: 'files' }).click()
    await page.getByTestId('file-panel').getByRole('button', { name: /\.md$/ }).first().click()
    await page.getByTestId('file-edit-toggle').click()
    await expect(page.getByTestId('file-panel').locator('.cm-content')).toBeVisible()
    expect(await fontSize('[data-testid="file-panel"] .cm-content')).toBe('16px')
  })
})

test.describe('settings', () => {
  test.use({ viewport: DESKTOP })

  test('the sidebar gear opens settings, the stepper changes the terminal text size', async ({ page }) => {
    await page.goto('/')
    await page.getByTestId('settings-open').click()
    await expect(page.getByTestId('settings')).toBeVisible()
    const value = page.getByTestId('font-size-value')
    const before = Number(await value.innerText())
    await page.getByTestId('font-size-up').click()
    await expect(value).toHaveText(String(before + 1))
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('settings')).toBeHidden()
  })

  test('the backdrop closes settings too', async ({ page }) => {
    await page.goto('/')
    await page.getByTestId('settings-open').click()
    await expect(page.getByTestId('settings')).toBeVisible()
    await page.getByTestId('settings-backdrop').click({ position: { x: 5, y: 5 } })
    await expect(page.getByTestId('settings')).toBeHidden()
  })
})

test.describe('keyboard shortcuts', () => {
  test.use({ viewport: DESKTOP })

  test("#9 Meta+' toggles the sidebar and Meta+\\ toggles the file panel, even with the terminal focused", async ({ page }) => {
    await page.goto('/')
    await expect(page.getByTestId('sidebar')).toBeVisible()
    // Focus the terminal area so the shortcut has to win over xterm.
    await page.getByTestId('terminal-area').click()
    await page.keyboard.press("Meta+'")
    await expect(page.getByTestId('sidebar')).toBeHidden()
    await page.keyboard.press("Meta+'")
    await expect(page.getByTestId('sidebar')).toBeVisible()
    await page.keyboard.press('Meta+\\')
    await expect(page.getByTestId('file-panel')).toBeVisible()
    await page.keyboard.press('Meta+\\')
    await expect(page.getByTestId('file-panel')).toBeHidden()
    // Ctrl+Shift+' for keyboards without a Command key. Plain Ctrl chords
    // are terminal input and must keep reaching it.
    await page.keyboard.press("Control+Shift+'")
    await expect(page.getByTestId('sidebar')).toBeHidden()
    await page.keyboard.press("Control+Shift+'")
    await expect(page.getByTestId('sidebar')).toBeVisible()
  })

  test('#9 Meta+K shows the leader hint, and Escape spends it without acting', async ({ page }) => {
    await page.goto('/')
    await page.getByTestId('terminal-area').click()
    await page.keyboard.press('Meta+k')
    // The hint waits a beat so anyone who knows the key never sees it.
    await expect(page.getByTestId('toast')).toContainText('n new')
    await expect(page.getByTestId('toast')).toHaveAttribute('data-tone', 'hint')
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('toast')).toBeHidden()
  })

  test('#9 Meta+K r opens the inline rename on the active session', async ({ page }) => {
    await page.goto('/')
    await expect(page.getByTestId('session-row').first()).toBeVisible()
    // From the terminal, so the chord has to win over xterm and the
    // sidebar has to take the request as it renders.
    await page.getByTestId('terminal-area').click()
    await page.keyboard.press('Meta+k')
    await page.keyboard.press('r')
    await expect(page.getByTestId('session-name-input')).toBeVisible()
    // Escape in the field cancels the rename rather than closing anything.
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('session-name-input')).toBeHidden()
  })

  test('#9 Meta+K x asks before killing, and Escape backs out', async ({ page }) => {
    await page.goto('/')
    await expect(page.getByTestId('sidebar')).toBeVisible()
    const sessions = await page.getByTestId('session-row').count()
    await page.getByTestId('terminal-area').click()
    await page.keyboard.press('Meta+k')
    await page.keyboard.press('x')
    // The confirmation skips the hint's delay: it is up straight away.
    await expect(page.getByTestId('toast')).toContainText('x again to confirm')
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('toast')).toBeHidden()
    await expect(page.getByTestId('session-row')).toHaveCount(sessions)
  })
})
