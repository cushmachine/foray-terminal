// Sidebar: AUDIT.md items 1, 3, 4, 7, 11.
import { test, expect } from '@playwright/test'
import { DESKTOP, MOBILE, createSession, killSession, openDrawer, sessionItem, uniqueName } from './helpers.ts'

test.describe('mobile drawer', () => {
  test.use({ viewport: MOBILE, isMobile: true, hasTouch: true })

  test('#1 close button is inside the viewport while open and hidden while closed', async ({ page }) => {
    await page.goto('/')
    const close = page.getByTestId('sidebar-close')
    // A closed drawer is off-screen; nothing in it may count as visible or
    // be reachable by Tab, a screen reader, or an automation tool.
    await expect(close).toBeHidden()

    await openDrawer(page)
    await expect(close).toBeVisible()
    const box = await close.boundingBox()
    expect(box).not.toBeNull()
    expect(box!.x).toBeGreaterThanOrEqual(0)
    expect(box!.x + box!.width).toBeLessThanOrEqual(MOBILE.width)
    expect(box!.y).toBeGreaterThanOrEqual(0)
    expect(box!.y + box!.height).toBeLessThanOrEqual(MOBILE.height)
    expect(box!.width).toBeGreaterThanOrEqual(44)
    expect(box!.height).toBeGreaterThanOrEqual(44)

    // Playwright's actionability check is the audit's repro: this click
    // timed out with "outside of the viewport".
    await close.click()
    await expect(page.getByTestId('sidebar')).toBeHidden()
    await expect(close).toBeHidden()
  })

  test('#3 backdrop covers the whole viewport, dims it, and closes the drawer on tap', async ({ page }) => {
    await page.goto('/')
    await openDrawer(page)
    const backdrop = page.getByTestId('sidebar-backdrop')
    await expect(backdrop).toBeVisible()
    expect(await backdrop.boundingBox()).toEqual({ x: 0, y: 0, width: MOBILE.width, height: MOBILE.height })
    const alpha = await backdrop.evaluate((el) => {
      const m = getComputedStyle(el).backgroundColor.match(/rgba?\(\d+,\s*\d+,\s*\d+(?:,\s*([\d.]+))?\)/)
      return m?.[1] === undefined ? 1 : Number(m[1])
    })
    expect(alpha).toBeGreaterThanOrEqual(0.7)
    await backdrop.click({ position: { x: MOBILE.width - 12, y: MOBILE.height / 2 } })
    await expect(page.getByTestId('sidebar')).toBeHidden()
  })
})

test.describe('session list', () => {
  test.use({ viewport: DESKTOP })

  test('#4 sessions are listed in creation order, not name order', async ({ page }) => {
    test.setTimeout(120_000) // creates three sessions
    await page.goto('/')
    // Lexicographic order would be b1, b10, b2. Creation order is what the
    // user expects: the newest session at the bottom.
    const names = [uniqueName('b10'), uniqueName('b2'), uniqueName('b1')]
    try {
      for (const name of names) await createSession(page, name)
      const listed = await page.getByTestId('session-item').allInnerTexts()
      const ours = listed.map((t) => names.find((n) => t.includes(n))).filter((n): n is string => n !== undefined)
      expect(ours).toEqual(names)
    } finally {
      for (const name of names) await killSession(page, name).catch(() => {})
    }
  })

  test('#7 a session entry carries its full name as a tooltip', async ({ page }) => {
    await page.goto('/')
    const name = uniqueName('tooltip-with-a-deliberately-long-name-that-truncates')
    try {
      await createSession(page, name)
      await expect(sessionItem(page, name)).toHaveAttribute('title', name)
    } finally {
      await killSession(page, name).catch(() => {})
    }
  })
})

test.describe('sidebar footer', () => {
  // Short viewport so the list overflows with only a few sessions.
  test.use({ viewport: { width: 1200, height: 360 } })

  test('#11 the new-session button stays pinned while the list scrolls', async ({ page }) => {
    test.setTimeout(120_000) // creates four sessions
    await page.goto('/')
    const names = [uniqueName('pin1'), uniqueName('pin2'), uniqueName('pin3'), uniqueName('pin4')]
    try {
      for (const name of names) await createSession(page, name)
      const button = page.getByTestId('new-session')
      await expect(button).toBeVisible()
      const box = await button.boundingBox()
      expect(box).not.toBeNull()
      expect(box!.y + box!.height).toBeLessThanOrEqual(360)
      // The list itself must be the thing that scrolls.
      const list = page.getByTestId('session-list')
      const overflows = await list.evaluate((el) => el.scrollHeight > el.clientHeight)
      expect(overflows).toBe(true)
    } finally {
      for (const name of names) await killSession(page, name).catch(() => {})
    }
  })
})
