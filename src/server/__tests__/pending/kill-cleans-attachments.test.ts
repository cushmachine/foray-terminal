// Pending for S4 (session:kill drops attachments on every connection).
//
// Killing a session kills the tmux session; every pty attached to it then
// exits on its own, but the server never notices: its handles, trackers
// and ownership entries for the dead window stay behind until the owning
// socket closes. session:kill must drop them on every connection.
//
// Run with: npx tsx --test src/server/__tests__/pending/kill-cleans-attachments.test.ts

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { connect, startTestServer, waitForType } from '../helpers.ts'

test('session:kill kills the ptys attached to that window on every connection', async () => {
  const { url, close, tmux, ptys } = await startTestServer()
  tmux.add('shell')
  tmux.add('other')
  try {
    const { ws: viewer } = await connect(url)
    const { ws: killer } = await connect(url)
    const attached = waitForType(viewer, 'terminal:history')
    viewer.send(JSON.stringify({ type: 'terminal:attach', windowId: 0 }))
    await attached
    assert.equal(ptys.length, 1)

    const killed = waitForType(viewer, 'session:killed')
    killer.send(JSON.stringify({ type: 'session:kill', windowId: 0 }))
    await killed
    assert.equal(ptys[0].killed, true, 'the viewer\'s pty for the killed window is killed')

    // The dead window is gone from ownership too: the next snapshot lists
    // only the window the killer attaches to now.
    const ownership = waitForType(killer, 'session:ownership')
    killer.send(JSON.stringify({ type: 'terminal:attach', windowId: 1 }))
    assert.deepEqual((await ownership).ownership, [{ windowId: 1, clients: 1 }])
    viewer.close()
    killer.close()
  } finally {
    await close()
  }
})
