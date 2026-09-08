// Pending for S4 (per-connection FIFO).
//
// A client sends terminal:attach and terminal:input back to back on page
// load (attach, then the keystroke the user was already typing). The input
// must reach the pty. Today the attach handler awaits tmux for history
// before it spawns, the input handler runs in the meantime, finds no pty
// and drops the keystroke on the floor.
//
// Run with: npx tsx --test src/server/__tests__/pending/message-order.test.ts

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { connect, startTestServer, until, waitForType } from '../helpers.ts'

test('input sent right after attach reaches the pty', async () => {
  const { url, close, tmux, ptys } = await startTestServer()
  tmux.add('shell')
  try {
    const { ws } = await connect(url)
    ws.send(JSON.stringify({ type: 'terminal:attach', windowId: 0 }))
    ws.send(JSON.stringify({ type: 'terminal:input', windowId: 0, data: 'ls\r' }))
    const pong = waitForType(ws, 'pong')
    ws.send(JSON.stringify({ type: 'ping' }))
    await pong
    await until(() => ptys.length >= 1, 'the pty to spawn')

    assert.deepEqual(ptys[0].writes, ['ls\r'], 'the input that followed the attach was written to its pty')
    ws.close()
  } finally {
    await close()
  }
})
