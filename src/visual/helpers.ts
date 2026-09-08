// Shared helpers for the visual suite. Everything here drives the real UI:
// sessions are created, renamed and killed the way a user would, through
// the sidebar, so the tests double as coverage for those flows.
//
// Test ids the suite relies on (data-testid):
//   sidebar, sidebar-close, sidebar-backdrop, sidebar-toggle, new-session,
//   session-row, session-item (data-session-id, data-active), session-rename,
//   session-kill, session-name-input, files-toggle, file-panel,
//   key-toolbar, key-toolbar-row, keytoolbar-fade-right, keytoolbar-toggle,
//   terminal (the active session's xterm container), version-banner.
// Test hook: the active Terminal publishes its xterm instance as
// window.__nest.term so tests can read the screen buffer, which the WebGL
// renderer does not expose in the DOM, and its actions as
// window.__nest.actions (terminalRegistry.ts) so tests can type into it.

import { expect, type Page } from '@playwright/test'

/** Every session a test creates is renamed to start with this. */
export const SESSION_PREFIX = 'visual-'

export const DESKTOP = { width: 1440, height: 900 }
export const TABLET = { width: 768, height: 1024 }
export const MOBILE = { width: 390, height: 844 }
export const NARROW = { width: 320, height: 568 }

/** A name no other test run will produce. */
export function uniqueName(label: string): string {
  return `${SESSION_PREFIX}${label}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`
}

/** Sidebar entry for a session, by its display name. */
export function sessionItem(page: Page, name: string) {
  return page.getByTestId('session-item').filter({ hasText: name })
}

/**
 * Create a session through the sidebar and rename it to `name`. Resolves once
 * the renamed entry is in the list. Creating switches the UI to the new
 * session, so it is also the active session afterwards.
 */
export async function createSession(page: Page, name: string): Promise<void> {
  // The welcome session:list arrives a beat after load. Counting before it
  // lands makes `before + 1` wrong once the list renders. A machine with no
  // sessions has nothing to wait for, so the wait is bounded and forgiving.
  await page.getByTestId('session-item').first().waitFor({ timeout: 3_000 }).catch(() => {})
  const before = await page.getByTestId('session-item').count()
  await page.getByTestId('new-session').click()
  await expect(page.getByTestId('session-item')).toHaveCount(before + 1)
  // On a phone, creating a session auto-closes the drawer (the new terminal
  // takes over); wait for it to settle, then reopen so the rename controls
  // are reachable. Read from the viewport rather than a live isHidden() check,
  // which races the close transition. Desktop keeps the sidebar pinned.
  const vp = page.viewportSize()
  if (vp && vp.width < 700) {
    await expect(page.getByTestId('sidebar')).toBeHidden()
    await page.getByTestId('sidebar-toggle').click()
    await expect(page.getByTestId('sidebar')).toBeVisible()
  }
  // The new session is the active one; its row carries the rename button.
  const row = page.getByTestId('session-row').filter({ has: page.locator('[data-active="true"]') }).last()
  await row.getByTestId('session-rename').click()
  const input = page.getByTestId('session-name-input')
  await input.fill(name)
  await input.press('Enter')
  await expect(sessionItem(page, name)).toBeVisible()
}

/** Kill a session through its sidebar row (two taps: arm, then confirm). */
export async function killSession(page: Page, name: string): Promise<void> {
  const row = page.getByTestId('session-row').filter({ hasText: name })
  await row.getByTestId('session-kill').click()
  await row.getByTestId('session-kill').click()
  await expect(sessionItem(page, name)).toHaveCount(0)
}

/** Open the drawer on a mobile viewport. */
export async function openDrawer(page: Page): Promise<void> {
  await page.getByTestId('sidebar-toggle').click()
  await expect(page.getByTestId('sidebar')).toBeVisible()
}

type NestActions = { sendKeys(data: string): void; submit(text: string): void }
type NestHook = { __nest?: { actions?: NestActions } }

/** Send raw input to the active terminal, as a toolbar key would. */
export async function sendKeys(page: Page, data: string): Promise<void> {
  await page.evaluate((d) => {
    (window as unknown as NestHook).__nest?.actions?.sendKeys(d)
  }, data)
}

/** Paste text and press Enter in the active terminal, as the Composer would. */
export async function submitText(page: Page, text: string): Promise<void> {
  await page.evaluate((t) => {
    (window as unknown as NestHook).__nest?.actions?.submit(t)
  }, text)
}

/** Text of a line in the active terminal's screen buffer, via the test hook Terminal.tsx exposes. */
export async function terminalLine(page: Page, row: number): Promise<string> {
  return page.evaluate((r) => {
    const term = (window as unknown as { __nest?: { term?: { buffer: { active: { getLine(n: number): { translateToString(trim?: boolean): string } | undefined } } } } }).__nest?.term
    return term?.buffer.active.getLine(r)?.translateToString(true) ?? ''
  }, row)
}

/** Whole visible screen of the active terminal, one string per row. */
export async function terminalScreen(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const term = (window as unknown as { __nest?: { term?: { rows: number; buffer: { active: { getLine(n: number): { translateToString(trim?: boolean): string } | undefined } } } } }).__nest?.term
    if (!term) return []
    const out: string[] = []
    for (let r = 0; r < term.rows; r++) out.push(term.buffer.active.getLine(r)?.translateToString(true) ?? '')
    return out
  })
}

/** Poll until the terminal has painted anything at all (a shell prompt, whatever it looks like). */
export async function expectTerminalReady(page: Page, timeout = 10_000): Promise<void> {
  await expect
    .poll(async () => (await terminalScreen(page)).join('').trim().length, { timeout })
    .toBeGreaterThan(0)
}

/** Poll until some terminal row contains `text`. */
export async function expectTerminalText(page: Page, text: string, timeout = 10_000): Promise<void> {
  await expect
    .poll(async () => (await terminalScreen(page)).join('\n'), { timeout })
    .toContain(text)
}
