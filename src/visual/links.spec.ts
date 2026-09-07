// URLs in the terminal on a phone. A URL on the visible screen surfaces in a
// link chip above the Composer with Open and Copy; the URL is re-joined
// across wrapped rows so it is exact. Once it scrolls into history it
// becomes a real <a> and leaves the chip.
//
// Every test creates its own tmux session; the session active on load may be
// someone's live shell.
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

const SCRATCH = '/tmp/claude-0/-root-GitHub-lifeos/90a908dc-7c4b-4b6d-98cf-a7ba7a8162bd/scratchpad'

// Long enough to wrap on a ~48 column phone terminal.
const URL = 'https://example.com/app/auth/cli/abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ'

/** Only the active session's terminal carries data-testid="terminal". */
const active = (page: Page) => page.getByTestId('terminal')

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

/** Print the URL through bash so it lands on the screen as program output. */
async function printUrl(page: Page): Promise<void> {
  await sendKeys(page, `printf 'Opening %s for login\\n' '${URL}'\r`)
  await expectTerminalText(page, 'for login')
}

test.describe('terminal links on mobile', () => {
  test.use({ viewport: MOBILE, isMobile: true, hasTouch: true })

  test('link chip opens and copies the exact URL across a wrap', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write'])
    await page.goto('/')
    const name = uniqueName('links-chip')
    try {
      await createMobileSession(page, name)
      await expectTerminalReady(page)
      await printUrl(page)

      const chip = page.getByTestId('terminal').getByTestId('link-chip')
      await expect(chip).toBeVisible()
      await expect(chip).toContainText('example.com')

      // Open: a new page with the exact, un-wrapped URL.
      const [popup] = await Promise.all([
        context.waitForEvent('page'),
        chip.getByTestId('link-open').first().click(),
      ])
      expect(popup.url()).toBe(URL)
      await popup.close()

      // Copy: the exact URL lands on the clipboard and the button says so.
      const copy = chip.getByTestId('link-copy').first()
      await copy.click()
      await expect.poll(() => page.evaluate(() => navigator.clipboard.readText()), { timeout: 5_000 }).toBe(URL)
      await expect(copy).toContainText('Copied')

      await page.screenshot({ path: `${SCRATCH}/links-chip.png` })
    } finally {
      await killMobileSession(page, name).catch(() => {})
    }
  })

  test('a URL that scrolls into history becomes a link and leaves the chip', async ({ page }) => {
    await page.goto('/')
    const name = uniqueName('links-hist')
    try {
      await createMobileSession(page, name)
      await expectTerminalReady(page)
      await printUrl(page)

      // Push the URL off the live screen into scrollback.
      await sendKeys(page, 'seq 1 80\r')
      await expectTerminalText(page, '80')

      await expect(page.locator(`a.term-link[href="${URL}"]`).first()).toBeAttached({ timeout: 10_000 })
      expect(await page.locator(`a.term-link[href="${URL}"]`).count()).toBeGreaterThanOrEqual(1)
      // The word after a URL that merely ends a line must never be glued on:
      // only a full-width row is a soft wrap.
      await expect(page.locator('a.term-link', { hasText: 'Opening' })).toHaveCount(0)
      await expect(page.locator('a.term-link', { hasText: 'for' })).toHaveCount(0)

      // Off-screen: no chip entry for it.
      const chip = page.getByTestId('terminal').getByTestId('link-chip')
      if (await chip.isVisible()) {
        await expect(chip).not.toContainText('example.com')
      }

      // Bring the link into view: both wrapped fragments should be underlined.
      await page.locator(`a.term-link[href="${URL}"]`).first().scrollIntoViewIfNeeded()
      await page.waitForTimeout(200)
      await expect(page.locator(`a.term-link[href="${URL}"]`).first()).toBeInViewport()
      await page.screenshot({ path: `${SCRATCH}/links-history.png` })
    } finally {
      await killMobileSession(page, name).catch(() => {})
    }
  })
})
