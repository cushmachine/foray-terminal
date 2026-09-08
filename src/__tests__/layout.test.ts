// Pure helpers behind the chrome: overflow hint, panel exclusivity, shortcuts, toolbar visibility.
//
// Run with: npx tsx --test src/__tests__/layout.test.ts

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { overflowHint, shortcutAction } from '../keys.ts'
import { TABLET_MAX_WIDTH, readToolbarVisible, resolvePanels, type PanelState } from '../mobile.ts'
import { KEY_TOOLBAR_KEY } from '../storage.ts'

const PHONE = 390
const DESKTOP = 1440

/** A desktop-layout panel state; the phone view is along for the ride. */
function desktop(sidebarOpen: boolean, filePanelOpen: boolean): PanelState {
  return { sidebarOpen, filePanelOpen, mobileView: 'terminal' }
}

test('#9 shortcutAction: Meta+B and Ctrl+Shift+B toggle the sidebar', () => {
  assert.equal(shortcutAction({ key: 'b', metaKey: true, ctrlKey: false, shiftKey: false, altKey: false }), 'toggle-sidebar')
  assert.equal(shortcutAction({ key: 'B', metaKey: false, ctrlKey: true, shiftKey: true, altKey: false }), 'toggle-sidebar')
})

test('#9 shortcutAction: Meta+\\ and Ctrl+Shift+\\ (which types |) toggle the file panel', () => {
  assert.equal(shortcutAction({ key: '\\', metaKey: true, ctrlKey: false, shiftKey: false, altKey: false }), 'toggle-files')
  assert.equal(shortcutAction({ key: '|', metaKey: false, ctrlKey: true, shiftKey: true, altKey: false }), 'toggle-files')
  assert.equal(shortcutAction({ key: '\\', metaKey: false, ctrlKey: true, shiftKey: true, altKey: false }), 'toggle-files')
})

test('#9 shortcutAction leaves terminal keys alone: plain keys, Ctrl+B (tmux prefix), Alt chords', () => {
  assert.equal(shortcutAction({ key: 'b', metaKey: false, ctrlKey: false, shiftKey: false, altKey: false }), null)
  assert.equal(shortcutAction({ key: 'b', metaKey: false, ctrlKey: true, shiftKey: false, altKey: false }), null)
  assert.equal(shortcutAction({ key: 'b', metaKey: false, ctrlKey: false, shiftKey: false, altKey: true }), null)
  assert.equal(shortcutAction({ key: 'x', metaKey: true, ctrlKey: false, shiftKey: false, altKey: false }), null)
})

test('#5 overflowHint says which edges have more content', () => {
  assert.deepEqual(overflowHint({ scrollLeft: 0, clientWidth: 300, scrollWidth: 500 }), { left: false, right: true })
  assert.deepEqual(overflowHint({ scrollLeft: 100, clientWidth: 300, scrollWidth: 500 }), { left: true, right: true })
  assert.deepEqual(overflowHint({ scrollLeft: 200, clientWidth: 300, scrollWidth: 500 }), { left: true, right: false })
  assert.deepEqual(overflowHint({ scrollLeft: 0, clientWidth: 500, scrollWidth: 500 }), { left: false, right: false })
  // Sub-pixel scroll positions must not flicker the hint.
  assert.deepEqual(overflowHint({ scrollLeft: 199.5, clientWidth: 300, scrollWidth: 500 }), { left: true, right: false })
})

test('#6 resolvePanels: below the tablet threshold the sidebar and file panel are exclusive', () => {
  const narrow = TABLET_MAX_WIDTH - 1
  assert.deepEqual(resolvePanels(desktop(true, false), 'toggle-files', narrow, false), desktop(false, true))
  assert.deepEqual(resolvePanels(desktop(false, true), 'toggle-sidebar', narrow, false), desktop(true, false))
  assert.deepEqual(resolvePanels(desktop(true, false), 'open-files', narrow, false), desktop(false, true))
  assert.deepEqual(resolvePanels(desktop(false, true), 'open-sidebar', narrow, false), desktop(true, false))
  // Closing never opens the other one.
  assert.deepEqual(resolvePanels(desktop(false, true), 'toggle-files', narrow, false), desktop(false, false))
  assert.deepEqual(resolvePanels(desktop(true, true), 'close-sidebar', narrow, false), desktop(false, true))
})

test('#6 resolvePanels: at desktop widths both panels can be open', () => {
  const wide = TABLET_MAX_WIDTH
  assert.deepEqual(resolvePanels(desktop(true, false), 'toggle-files', wide, false), desktop(true, true))
  assert.deepEqual(resolvePanels(desktop(true, true), 'toggle-sidebar', wide, false), desktop(false, true))
  assert.deepEqual(resolvePanels(desktop(true, true), 'open-files', wide, false), desktop(true, true))
  assert.deepEqual(resolvePanels(desktop(true, true), 'open-file', wide, false), desktop(true, true))
})

// On a phone the file panel is a view, not a panel: the actions below move
// mobileView and close the drawer, and never touch filePanelOpen.

test('resolvePanels: opening a file on a phone shows the files view and closes the drawer', () => {
  const start: PanelState = { sidebarOpen: true, filePanelOpen: false, mobileView: 'terminal' }
  const next = resolvePanels(start, 'open-file', PHONE, true)
  assert.equal(next.mobileView, 'files')
  assert.equal(next.sidebarOpen, false)
  assert.equal(next.filePanelOpen, false)
})

test('resolvePanels: selecting a session on a phone shows the terminal and closes the drawer', () => {
  const start: PanelState = { sidebarOpen: true, filePanelOpen: false, mobileView: 'files' }
  const next = resolvePanels(start, 'select-session', PHONE, true)
  assert.equal(next.mobileView, 'terminal')
  assert.equal(next.sidebarOpen, false)
})

test('resolvePanels: closing a file on a phone returns to the terminal', () => {
  const start: PanelState = { sidebarOpen: false, filePanelOpen: false, mobileView: 'files' }
  assert.equal(resolvePanels(start, 'close-file', PHONE, true).mobileView, 'terminal')
})

test('resolvePanels: toggle-files on a phone flips the view', () => {
  const start: PanelState = { sidebarOpen: false, filePanelOpen: false, mobileView: 'terminal' }
  const files = resolvePanels(start, 'toggle-files', PHONE, true)
  assert.equal(files.mobileView, 'files')
  assert.equal(files.filePanelOpen, false, 'the desktop panel flag is not the phone view')
  assert.equal(resolvePanels(files, 'toggle-files', PHONE, true).mobileView, 'terminal')
})

test('resolvePanels: the segmented control picks a view on a phone', () => {
  const start: PanelState = { sidebarOpen: false, filePanelOpen: false, mobileView: 'terminal' }
  assert.equal(resolvePanels(start, 'show-files', PHONE, true).mobileView, 'files')
  assert.equal(resolvePanels({ ...start, mobileView: 'files' }, 'show-terminal', PHONE, true).mobileView, 'terminal')
})

test('resolvePanels: on desktop mobileView is left alone and the sidebar stays put', () => {
  const start: PanelState = { sidebarOpen: true, filePanelOpen: false, mobileView: 'terminal' }
  assert.equal(resolvePanels(start, 'open-file', DESKTOP, false).mobileView, 'terminal')
  assert.equal(resolvePanels(start, 'select-session', DESKTOP, false), start)
  assert.equal(resolvePanels(start, 'close-file', DESKTOP, false), start)
  assert.equal(resolvePanels(start, 'show-files', DESKTOP, false), start)
})

test('#10 readToolbarVisible: always on for touch layouts, off by default on desktop, persisted choice wins', () => {
  assert.equal(readToolbarVisible(null, true), true)
  assert.equal(readToolbarVisible('false', true), true)
  assert.equal(readToolbarVisible(null, false), false)
  assert.equal(readToolbarVisible('true', false), true)
  assert.equal(readToolbarVisible('false', false), false)
  assert.equal(readToolbarVisible('garbage', false), false)
  assert.equal(typeof KEY_TOOLBAR_KEY, 'string')
})
