// Markdown editor and file panel header, pending for S7.
//
// The editor rebuilds its CodeMirror view on every keystroke (its effect
// keys on `content`, which the parent updates as you type), so the cursor
// jumps and focus is lost. The panel header has one close button that
// closes the whole panel where "back to the tree" was meant. Both specs
// are fixme until S7 lands; S7 removes the fixme.
//
// Expected accessible names after S7: "Back to files" (returns to the
// tree) and "Close panel" (closes the panel), on both layouts.
import { test, expect, type Page } from '@playwright/test'
import { DESKTOP, MOBILE } from './helpers.ts'

/** Open the first .md file in the active session's cwd, via the file panel. */
async function openMarkdownFile(page: Page, mobile: boolean): Promise<void> {
  if (mobile) await page.getByRole('button', { name: 'files' }).click()
  else await page.getByTestId('files-toggle').click()
  await expect(page.getByTestId('file-panel')).toBeVisible()
  await page.getByTestId('file-panel').getByRole('button', { name: /\.md$/ }).first().click()
  await expect(page.getByTestId('file-edit-toggle')).toBeVisible()
}

test.describe('markdown editor', () => {
  test.use({ viewport: DESKTOP })

  test.fixme('typing keeps the cursor at the end and never loses focus', async ({ page }) => {
    await page.goto('/')
    await openMarkdownFile(page, false)
    await page.getByTestId('file-edit-toggle').click()
    const content = page.getByTestId('file-panel').locator('.cm-content')
    await expect(content).toBeVisible()
    const before = (await content.innerText()).replace(/\n$/, '')

    // Put the cursor at the very end, then type twenty characters one by one.
    await content.click()
    await page.keyboard.press('Control+End')
    const typed = 'abcdefghijklmnopqrst'
    for (const ch of typed) await page.keyboard.type(ch)

    // The document is the old text plus what was typed, in order.
    await expect.poll(() => content.innerText().then((t) => t.replace(/\n$/, ''))).toBe(before + typed)
    // Focus never left the editor.
    expect(await page.evaluate(() => document.activeElement?.classList.contains('cm-content'))).toBe(true)
    // The cursor sits after the last typed character: typing once more appends.
    await page.keyboard.type('!')
    await expect.poll(() => content.innerText().then((t) => t.replace(/\n$/, ''))).toBe(`${before}${typed}!`)
  })
})

test.describe('file panel header on desktop', () => {
  test.use({ viewport: DESKTOP })

  test.fixme('back returns to the tree; close closes the panel', async ({ page }) => {
    await page.goto('/')
    await openMarkdownFile(page, false)

    await page.getByTestId('file-panel').getByRole('button', { name: 'Back to files' }).click()
    await expect(page.getByTestId('file-panel')).toBeVisible()
    await expect(page.getByTestId('file-panel').getByRole('button', { name: /\.md$/ }).first()).toBeVisible()
    await expect(page.getByTestId('file-edit-toggle')).toHaveCount(0)

    await page.getByTestId('file-panel').getByRole('button', { name: 'Close panel' }).click()
    await expect(page.getByTestId('file-panel')).toBeHidden()
  })
})

test.describe('file panel header on a phone', () => {
  test.use({ viewport: MOBILE, isMobile: true, hasTouch: true })

  test.fixme('back returns to the tree', async ({ page }) => {
    await page.goto('/')
    await openMarkdownFile(page, true)

    await page.getByTestId('file-panel').getByRole('button', { name: 'Back to files' }).click()
    await expect(page.getByTestId('file-panel')).toBeVisible()
    await expect(page.getByTestId('file-panel').getByRole('button', { name: /\.md$/ }).first()).toBeVisible()
    await expect(page.getByTestId('file-edit-toggle')).toHaveCount(0)
  })
})
