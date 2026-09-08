// Pending for S4 (pty-bridge wires onExit; the handler sends terminal:exited).
//
// When `tmux attach` exits under the pty (the session was killed from
// another client, or tmux itself went away) the client is told with
// terminal:exited and the handler forgets the pty, so later input is not
// written into a dead handle. Today the bridge never registers onExit.
//
// Run with: npx tsx --test src/server/__tests__/pending/pty-exit.test.ts

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { connect, startTestServer, waitForType } from '../helpers.ts'

test('a pty exit sends terminal:exited and drops the handle', async () => {
  const { url, close, tmux, ptys } = await startTestServer()
  tmux.add('shell')
  try {
    const { ws } = await connect(url)
    const attached = waitForType(ws, 'terminal:history')
    ws.send(JSON.stringify({ type: 'terminal:attach', windowId: 0 }))
    await attached
    assert.equal(ptys.length, 1)

    const exited = waitForType(ws, 'terminal:exited', 1000)
    ptys[0].exit(0)
    assert.equal((await exited).windowId, 0)

    // Input after the exit has nowhere to go.
    const pong = waitForType(ws, 'pong')
    ws.send(JSON.stringify({ type: 'terminal:input', windowId: 0, data: 'late\r' }))
    ws.send(JSON.stringify({ type: 'ping' }))
    await pong
    assert.deepEqual(ptys[0].writes, [], 'no writes into an exited pty')
    ws.close()
  } finally {
    await close()
  }
})
