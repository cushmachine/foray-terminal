// Pending for S5 (resolvePanels owns mobileView; App's `if (isMobile)` branches collapse).
//
// App keeps mobileView ('terminal' | 'files') in its own state and five
// separate `if (isMobile)` branches decide when it flips. The decisions
// belong in resolvePanels next to the sidebar/file-panel rules. Expected
// in src/mobile.ts:
//
//   interface PanelState { sidebarOpen; filePanelOpen; mobileView: MobileView }
//   type PanelAction = ... | 'select-session' | 'open-file' | 'close-file'
//   resolvePanels(state, action, width, isMobile): PanelState
//
// On a phone: opening a file shows the files view and closes the drawer,
// selecting a session shows the terminal and closes the drawer, closing a
// file returns to the terminal, and toggle-files flips the view. On
// desktop mobileView never changes. Today the result carries no mobileView
// at all.
//
// Run with: npx tsx --test src/__tests__/pending/resolvePanels-mobile.test.ts

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolvePanels } from '../../mobile.ts'

interface PanelStateWithView {
  sidebarOpen: boolean
  filePanelOpen: boolean
  mobileView: 'terminal' | 'files'
}

type Resolve = (state: PanelStateWithView, action: string, width: number, isMobile: boolean) => PanelStateWithView

// Loosened so the file compiles until the signature grows; the runtime
// checks below are what matter. An action the reducer does not know falls
// off the end of its switch, so check that it answered at all.
const loose = resolvePanels as unknown as Resolve
const resolve: Resolve = (state, action, width, isMobile) => {
  const next = loose(state, action, width, isMobile)
  assert.ok(next, `resolvePanels does not handle '${action}'`)
  return next
}

const PHONE = 390
const DESKTOP = 1440

test('opening a file on a phone shows the files view and closes the drawer', () => {
  const start: PanelStateWithView = { sidebarOpen: true, filePanelOpen: false, mobileView: 'terminal' }
  const next = resolve(start, 'open-file', PHONE, true)
  assert.equal(next.mobileView, 'files')
  assert.equal(next.sidebarOpen, false)
})

test('selecting a session on a phone shows the terminal and closes the drawer', () => {
  const start: PanelStateWithView = { sidebarOpen: true, filePanelOpen: false, mobileView: 'files' }
  const next = resolve(start, 'select-session', PHONE, true)
  assert.equal(next.mobileView, 'terminal')
  assert.equal(next.sidebarOpen, false)
})

test('closing a file on a phone returns to the terminal', () => {
  const start: PanelStateWithView = { sidebarOpen: false, filePanelOpen: false, mobileView: 'files' }
  assert.equal(resolve(start, 'close-file', PHONE, true).mobileView, 'terminal')
})

test('toggle-files on a phone flips the view', () => {
  const start: PanelStateWithView = { sidebarOpen: false, filePanelOpen: false, mobileView: 'terminal' }
  const files = resolve(start, 'toggle-files', PHONE, true)
  assert.equal(files.mobileView, 'files')
  assert.equal(resolve(files, 'toggle-files', PHONE, true).mobileView, 'terminal')
})

test('on desktop mobileView is left alone', () => {
  const start: PanelStateWithView = { sidebarOpen: true, filePanelOpen: false, mobileView: 'terminal' }
  assert.equal(resolve(start, 'open-file', DESKTOP, false).mobileView, 'terminal')
  assert.equal(resolve(start, 'select-session', DESKTOP, false).sidebarOpen, true)
})
