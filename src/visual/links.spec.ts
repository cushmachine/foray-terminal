// URLs in the terminal on a phone. Once a URL scrolls into history it
// becomes a real <a>, re-joined across wrapped rows so the href is exact.
// (Anything on the live screen is reached through select mode instead; see
// keyboard.spec.ts.)
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

// Long enough to wrap on a ~48 column phone terminal.
const URL = 'https://example.com/app/auth/cli/abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ'


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

  test('a URL that scrolls into history becomes a link', async ({ page }) => {
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

      // Bring the link into view: both wrapped fragments should be underlined.
      await page.locator(`a.term-link[href="${URL}"]`).first().scrollIntoViewIfNeeded()
      await page.waitForTimeout(200)
      await expect(page.locator(`a.term-link[href="${URL}"]`).first()).toBeInViewport()
    } finally {
      await killMobileSession(page, name).catch(() => {})
    }
  })
})
