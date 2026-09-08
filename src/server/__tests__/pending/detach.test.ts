// Pending for S4 (terminal:detach message and handler).
//
// Only the active terminal should hold a pty; switching sessions on a
// phone sends terminal:detach for the one left behind. The server kills
// that pty, releases ownership and broadcasts the new snapshot. Today the
// message type does not exist and falls through the dispatch switch
// unanswered.
//
// Run with: npx tsx --test src/server/__tests__/pending/detach.test.ts

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { connect, startTestServer, waitForType } from '../helpers.ts'

test('terminal:detach kills the pty and releases ownership', async () => {
  const { url, close, tmux, ptys } = await startTestServer()
  tmux.add('shell')
  try {
    const { ws } = await connect(url)
    const attached = waitForType(ws, 'session:ownership')
    ws.send(JSON.stringify({ type: 'terminal:attach', windowId: 0 }))
    assert.deepEqual((await attached).ownership, [{ windowId: 0, clients: 1 }])

    const ownership = waitForType(ws, 'session:ownership', 1000)
    // Awaited below; if the assertion before it fails, its timeout must not
    // surface as a stray rejection after the test ended.
    ownership.catch(() => {})
    const pong = waitForType(ws, 'pong')
    ws.send(JSON.stringify({ type: 'terminal:detach', windowId: 0 }))
    ws.send(JSON.stringify({ type: 'ping' }))
    await pong
    assert.equal(ptys[0].killed, true, 'detach kills the pty')
    assert.deepEqual((await ownership).ownership, [], 'detach releases ownership')
    ws.close()
  } finally {
    await close()
  }
})
