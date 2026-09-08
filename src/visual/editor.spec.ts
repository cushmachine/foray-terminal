// Markdown editor and file panel header.
//
// The editor used to rebuild its CodeMirror view on every keystroke (its
// effect keyed on `content`, which the parent updates as you type), so the
// cursor jumped and focus was lost; now the view lives as long as the file
// is open and outside content is dispatched into it. The header has two
// buttons: "Back to files" returns to the tree and "Close panel" hides the
// panel (desktop) or returns to the terminal (phone).
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

  test('typing keeps the cursor at the end and never loses focus', async ({ page }) => {
    await page.goto('/')
    await openMarkdownFile(page, false)
    await page.getByTestId('file-edit-toggle').click()
    const content = page.getByTestId('file-panel').locator('.cm-content')
    await expect(content).toBeVisible()

    // Put the cursor at the very end, then type twenty characters one by one.
    // CodeMirror virtualises long documents (only the lines near the viewport
    // are in the DOM), so the checks look at the document's tail rather than
    // comparing the whole text: a rebuilt view would put the cursor back at
    // offset 0 and the typed text would land at the top, not the end.
    await content.click()
    await page.keyboard.press('Control+End')
    const tail = () => content.innerText().then((t) => t.replace(/\n$/, ''))
    const typed = 'abcdefghijklmnopqrst'
    for (const ch of typed) await page.keyboard.type(ch)

    await expect.poll(tail).toMatch(new RegExp(`${typed}$`))
    // Focus never left the editor.
    expect(await page.evaluate(() => document.activeElement?.classList.contains('cm-content'))).toBe(true)
    // The cursor sits after the last typed character: typing once more appends.
    await page.keyboard.type('!')
    await expect.poll(tail).toMatch(new RegExp(`${typed}!$`))
  })
})

test.describe('file panel header on desktop', () => {
  test.use({ viewport: DESKTOP })

  test('back returns to the tree; close closes the panel', async ({ page }) => {
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

  test('back returns to the tree', async ({ page }) => {
    await page.goto('/')
    await openMarkdownFile(page, true)

    await page.getByTestId('file-panel').getByRole('button', { name: 'Back to files' }).click()
    await expect(page.getByTestId('file-panel')).toBeVisible()
    await expect(page.getByTestId('file-panel').getByRole('button', { name: /\.md$/ }).first()).toBeVisible()
    await expect(page.getByTestId('file-edit-toggle')).toHaveCount(0)
  })
})
