// The login screen: a browser without the session cookie sees it and
// nothing else, a wrong token is refused, the right one opens the app.
//
// Every other spec starts logged in (global-setup writes the cookie into
// the storage state); this one starts from an empty state on purpose.
import { test, expect } from '@playwright/test'
import { VISUAL_TOKEN } from '../../playwright.config.ts'
import { DESKTOP } from './helpers.ts'

test.describe('login', () => {
  test.use({ viewport: DESKTOP, storageState: { cookies: [], origins: [] } })

  test('a browser without the cookie is asked for the token and let in with it', async ({ page }) => {
    await page.goto('/')
    await expect(page.getByTestId('login')).toBeVisible()
    await expect(page.getByTestId('sidebar')).toHaveCount(0)

    await page.getByTestId('login-token').fill('not-the-token')
    await page.getByTestId('login-submit').click()
    await expect(page.getByTestId('login-error')).toHaveText(/not the token/)
    await expect(page.getByTestId('login')).toBeVisible()

    await page.getByTestId('login-token').fill(VISUAL_TOKEN)
    await page.getByTestId('login-submit').click()
    await expect(page.getByTestId('sidebar')).toBeVisible()

    // The cookie is HttpOnly: the page cannot read it, and it survives a reload.
    expect(await page.evaluate(() => document.cookie)).not.toContain('foray_session')
    await page.reload()
    await expect(page.getByTestId('sidebar')).toBeVisible()
    await expect(page.getByTestId('login')).toHaveCount(0)
  })

  test('the page carries a content security policy and cannot be framed', async ({ page }) => {
    const response = await page.goto('/')
    const headers = response?.headers() ?? {}
    expect(headers['content-security-policy']).toContain("frame-ancestors 'none'")
    expect(headers['x-frame-options']).toBe('DENY')
    expect(headers['referrer-policy']).toBe('no-referrer')
    // The app rendered under that policy: no inline script or foreign
    // resource it needs was blocked.
    await expect(page.getByTestId('login')).toBeVisible()
  })
})
