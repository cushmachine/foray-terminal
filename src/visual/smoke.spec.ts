import { test, expect } from '@playwright/test'
import { DESKTOP } from './helpers.ts'

test.use({ viewport: DESKTOP })

test('the app loads, connects, and lists sessions', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.goto('/')
  await expect(page.getByText('foray', { exact: true })).toBeVisible()
  // exact: the sidebar also has a "Past sessions" toggle, which a substring
  // match picks up too and Playwright's strict mode then refuses.
  await expect(page.getByText('Sessions', { exact: true })).toBeVisible()
  // The version banner must not fire on a matched build and server.
  await expect(page.getByRole('status')).toHaveCount(0)
  expect(errors).toEqual([])
})
