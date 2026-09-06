// Pure helpers behind AUDIT.md items 5, 6, 9, 10.
//
// Run with: npm run test:layout

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { overflowHint, shortcutAction } from '../keys.ts'
import { KEY_TOOLBAR_KEY, TABLET_MAX_WIDTH, readToolbarVisible, resolvePanels } from '../mobile.ts'

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
  assert.deepEqual(resolvePanels({ sidebarOpen: true, filePanelOpen: false }, 'toggle-files', narrow), { sidebarOpen: false, filePanelOpen: true })
  assert.deepEqual(resolvePanels({ sidebarOpen: false, filePanelOpen: true }, 'toggle-sidebar', narrow), { sidebarOpen: true, filePanelOpen: false })
  assert.deepEqual(resolvePanels({ sidebarOpen: true, filePanelOpen: false }, 'open-files', narrow), { sidebarOpen: false, filePanelOpen: true })
  // Closing never opens the other one.
  assert.deepEqual(resolvePanels({ sidebarOpen: false, filePanelOpen: true }, 'toggle-files', narrow), { sidebarOpen: false, filePanelOpen: false })
})

test('#6 resolvePanels: at desktop widths both panels can be open', () => {
  const wide = TABLET_MAX_WIDTH
  assert.deepEqual(resolvePanels({ sidebarOpen: true, filePanelOpen: false }, 'toggle-files', wide), { sidebarOpen: true, filePanelOpen: true })
  assert.deepEqual(resolvePanels({ sidebarOpen: true, filePanelOpen: true }, 'toggle-sidebar', wide), { sidebarOpen: false, filePanelOpen: true })
  assert.deepEqual(resolvePanels({ sidebarOpen: true, filePanelOpen: true }, 'open-files', wide), { sidebarOpen: true, filePanelOpen: true })
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
