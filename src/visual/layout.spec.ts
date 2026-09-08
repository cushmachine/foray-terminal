// Layout and chrome: AUDIT.md items 5, 6, 9, 10.
import { test, expect } from '@playwright/test'
import { DESKTOP, MOBILE, NARROW, TABLET } from './helpers.ts'

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
    const closeBtn = page.getByRole('button', { name: 'Close file' })
    await expect(closeBtn).toBeVisible()
    const closeBox = await closeBtn.boundingBox()
    expect(closeBox).not.toBeNull()
    expect(closeBox!.width).toBeGreaterThan(10)
    expect(closeBox!.x + closeBox!.width).toBeLessThanOrEqual(MOBILE.width)
    const panel = await page.getByTestId('file-panel').boundingBox()
    expect(panel!.width).toBeLessThanOrEqual(MOBILE.width)
  })
})

test.describe('keyboard shortcuts', () => {
  test.use({ viewport: DESKTOP })

  test('#9 Meta+B toggles the sidebar and Meta+\\ toggles the file panel, even with the terminal focused', async ({ page }) => {
    await page.goto('/')
    await expect(page.getByTestId('sidebar')).toBeVisible()
    // Focus the terminal area so the shortcut has to win over xterm.
    await page.getByTestId('terminal-area').click()
    await page.keyboard.press('Meta+b')
    await expect(page.getByTestId('sidebar')).toBeHidden()
    await page.keyboard.press('Meta+b')
    await expect(page.getByTestId('sidebar')).toBeVisible()
    await page.keyboard.press('Meta+\\')
    await expect(page.getByTestId('file-panel')).toBeVisible()
    await page.keyboard.press('Meta+\\')
    await expect(page.getByTestId('file-panel')).toBeHidden()
    // Ctrl+Shift+B for keyboards without a Command key. Plain Ctrl+B is the
    // tmux prefix and must keep reaching the terminal.
    await page.keyboard.press('Control+Shift+b')
    await expect(page.getByTestId('sidebar')).toBeHidden()
    await page.keyboard.press('Control+Shift+b')
    await expect(page.getByTestId('sidebar')).toBeVisible()
  })
})
