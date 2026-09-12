// Key passthrough through tmux, at the byte level: Shift+Enter must reach the pane as CSI u.
//
// Run with: npm run test:keys   (requires tmux)
//
// Foray's xterm sends Shift+Enter as CSI u (ESC [ 13 ; 2 u). tmux parses
// that as the key Enter+Shift and, unless told to pass extended keys on to
// the pane, re-encodes it as a plain carriage return. Claude Code inside
// the pane then sees Enter and submits instead of inserting a newline.
// This test drives the real path: WebSocket -> pty -> tmux -> pane.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { startServer } from '../server/index.ts'
import { TEST_TOKEN, connect, waitForMessage, waitForOutput, waitForTypeOrError } from '../server/__tests__/helpers.ts'
import { tmuxSync } from './helpers.ts'

const SHIFT_ENTER_CSI_U = '\x1b[13;2u'

function hasTmux(): boolean {
  try {
    tmuxSync(['-V'])
    return true
  } catch {
    return false
  }
}

test('Shift+Enter as CSI u reaches the pane unchanged', { skip: !hasTmux() && 'tmux not installed' }, async () => {
  const { url, close } = await startServer(0, { quiet: true, host: '127.0.0.1', auth: { token: TEST_TOKEN } })
  const { ws } = await connect(url)
  const created = waitForTypeOrError(ws, 'session:created')
  ws.send(JSON.stringify({ type: 'session:create', name: `e2e-keys-${Date.now().toString(36)}` }))
  const windowId = ((await created).window as { id: number }).id
  try {
    ws.send(JSON.stringify({ type: 'terminal:attach', windowId, cols: 100, rows: 30 }))
    // Input sent before the attach has spawned its pty is dropped, so wait
    // for the first paint (the alternate-screen switch) before typing. No
    // prompt wait beyond that: prompts differ per machine ($ vs #).
    await waitForOutput(ws, windowId, '\x1b[?1049h')
    ws.send(JSON.stringify({ type: 'terminal:input', windowId, data: 'cat -v\r' }))
    await waitForOutput(ws, windowId, 'cat -v')
    ws.send(JSON.stringify({ type: 'terminal:input', windowId, data: SHIFT_ENTER_CSI_U }))
    // cat -v renders ESC as ^[ . If tmux downgraded the key, only a bare
    // newline arrives and the wait fails with the raw output in the message.
    const out = await waitForOutput(ws, windowId, '^[[13;2u')
    assert.ok(out.includes('^[[13;2u'))
  } finally {
    ws.send(JSON.stringify({ type: 'terminal:input', windowId, data: '\x03' }))
    const killed = waitForMessage(ws, (m) => m.type === 'session:killed' && m.windowId === windowId)
    ws.send(JSON.stringify({ type: 'session:kill', windowId }))
    await killed.catch(() => {})
    ws.close()
    await close()
  }
})
