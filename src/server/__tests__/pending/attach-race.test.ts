// Pending for S4 (per-connection FIFO, attach re-checks the pty map).
//
// Two terminal:attach messages for one window on one connection must leave
// exactly one live pty: the later attach wins and the earlier pty is
// killed. Today each attach awaits the history round-trip before it
// spawns and nothing serialises a connection's messages, so both attaches
// find the map empty and both spawn; the tmux session then has two
// clients from one browser tab.
//
// Run with: npx tsx --test src/server/__tests__/pending/attach-race.test.ts

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { connect, startTestServer, until, waitForType } from '../helpers.ts'

test('two attaches for one window on one connection leave one live pty', async () => {
  const { url, close, tmux, ptys } = await startTestServer()
  tmux.add('shell')
  try {
    const { ws } = await connect(url)
    ws.send(JSON.stringify({ type: 'terminal:attach', windowId: 0 }))
    ws.send(JSON.stringify({ type: 'terminal:attach', windowId: 0 }))
    // Once messages are handled in order the pong proves both attaches are
    // done; until then, give a spawn that slipped past the pong time to land.
    const pong = waitForType(ws, 'pong')
    ws.send(JSON.stringify({ type: 'ping' }))
    await pong
    await until(() => ptys.length >= 1, 'a pty to spawn')
    await new Promise((resolve) => setTimeout(resolve, 100))

    const live = ptys.filter((p) => !p.killed)
    assert.equal(live.length, 1, `expected one live pty, found ${live.length} of ${ptys.length} spawned`)
    assert.equal(ptys[0].killed, true, 'the first attach\'s pty is killed by the second')
    ws.close()
  } finally {
    await close()
  }
})
