// Session QoL: auto-close drawer on create, reopen last session on load,
// per-session composer drafts.
import { test, expect } from '@playwright/test'
import { DESKTOP, MOBILE, createSession, killSession, openDrawer, sessionItem, uniqueName } from './helpers.ts'

test.describe('creating a session on mobile', () => {
  test.use({ viewport: MOBILE, isMobile: true, hasTouch: true })

  test('the drawer closes so the new terminal is in view', async ({ page }) => {
    await page.goto('/')
    await openDrawer(page)
    await expect(page.getByTestId('sidebar')).toBeVisible()
    const before = await page.getByTestId('session-item').count()
    await page.getByTestId('new-session').click()
    await expect(page.getByTestId('session-item')).toHaveCount(before + 1)
    // The feature: the drawer auto-closes on create.
    await expect(page.getByTestId('sidebar')).toBeHidden()

    // Reopen to rename the new (active) session so global-teardown removes it.
    const name = uniqueName('autoclose')
    await openDrawer(page)
    const row = page.getByTestId('session-row').filter({ has: page.locator('[data-active="true"]') }).last()
    await row.getByTestId('session-rename').click()
    const input = page.getByTestId('session-name-input')
    await input.fill(name)
    await input.press('Enter')
    await expect(sessionItem(page, name)).toBeVisible()
    await killSession(page, name).catch(() => {})
  })
})

test.describe('reopening the last session', () => {
  test.use({ viewport: DESKTOP })

  test('a reload returns to the session this device last viewed', async ({ page }) => {
    test.setTimeout(120_000)
    await page.goto('/')
    const a = uniqueName('last-a')
    const b = uniqueName('last-b')
    try {
      await createSession(page, a)
      await createSession(page, b) // creating switches to b, so b is active now
      await expect(sessionItem(page, b)).toHaveAttribute('data-active', 'true')

      // Look at a, then reload: a should come back active, not the first in the list.
      await sessionItem(page, a).click()
      await expect(sessionItem(page, a)).toHaveAttribute('data-active', 'true')
      await page.reload()
      await expect(sessionItem(page, a)).toHaveAttribute('data-active', 'true')
    } finally {
      await killSession(page, a).catch(() => {})
      await killSession(page, b).catch(() => {})
    }
  })
})

test.describe('composer drafts', () => {
  test.use({ viewport: MOBILE, isMobile: true, hasTouch: true })

  test('unsent text is kept per session across switches', async ({ page }) => {
    test.setTimeout(120_000)
    await page.goto('/')
    const a = uniqueName('draft-a')
    const b = uniqueName('draft-b')
    const composer = page.getByLabel('Message to send to the terminal')
    try {
      // createSession opens the drawer to rename; it stays open afterwards.
      await openDrawer(page)
      await createSession(page, a)
      await page.getByTestId('sidebar-close').click()
      await openDrawer(page)
      await createSession(page, b)
      await page.getByTestId('sidebar-close').click()

      // b is active. Type a draft for b, do not send.
      await composer.fill('draft for bee')

      // Switch to a: confirm the switch landed, then its composer is empty.
      await openDrawer(page)
      await sessionItem(page, a).click()
      await expect(sessionItem(page, a)).toHaveAttribute('data-active', 'true')
      await expect(composer).toHaveValue('')
      // Type a draft for a.
      await composer.fill('draft for ay')

      // Back to b: bee's draft is restored, not ay's.
      await openDrawer(page)
      await sessionItem(page, b).click()
      await expect(sessionItem(page, b)).toHaveAttribute('data-active', 'true')
      await expect(composer).toHaveValue('draft for bee')
    } finally {
      // On mobile the drawer is closed after a session switch; open it so the
      // kill controls are reachable.
      await openDrawer(page).catch(() => {})
      await killSession(page, a).catch(() => {})
      await killSession(page, b).catch(() => {})
    }
  })
})
