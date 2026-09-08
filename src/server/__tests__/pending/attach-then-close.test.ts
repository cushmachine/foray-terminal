// Pending for S4 (`closed` flag; attach re-checks it after every await).
//
// A socket that closes while its terminal:attach is still waiting on tmux
// for history must not end up with a pty or an ownership entry: today the
// attach carries on after the close handler ran, claims the window for a
// socket that is gone and spawns a pty nobody will ever kill.
//
// Run with: npx tsx --test src/server/__tests__/pending/attach-then-close.test.ts

import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { TmuxExecutor } from '../../tmux.ts'
import { connect, fakeTmux, startTestServer, until, waitForType } from '../helpers.ts'

test('closing mid-attach leaves no pty and no phantom owner', async () => {
  const tmux = fakeTmux()
  tmux.add('shell')
  tmux.add('other')
  // Hold the first history query until the test says so.
  let gated = false
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const exec: TmuxExecutor = async (cmd, args) => {
    if (args[0] === 'display-message' && !gated) {
      gated = true
      await gate
    }
    return tmux.exec(cmd, args)
  }
  const { url, close, ptys } = await startTestServer({ tmuxExec: exec })
  try {
    const { ws: ws1 } = await connect(url)
    const { ws: ws2 } = await connect(url)

    ws1.send(JSON.stringify({ type: 'terminal:attach', windowId: 0 }))
    await until(() => gated, 'the attach to reach tmux')

    // ws1 goes away while tmux is still answering; the close handler's
    // release broadcast tells us the server has processed the close.
    const released = waitForType(ws2, 'session:ownership')
    ws1.close()
    await released
    release()
    // The stalled attach resumes on the microtask queue; one turn of the
    // event loop is enough for it to run to its end.
    await new Promise((resolve) => setImmediate(resolve))

    const live = ptys.filter((p) => !p.killed)
    assert.equal(live.length, 0, 'a late attach must not leave a pty for a closed socket')

    // Ownership reflects only the connections that exist.
    const ownership = waitForType(ws2, 'session:ownership')
    ws2.send(JSON.stringify({ type: 'terminal:attach', windowId: 1 }))
    assert.deepEqual((await ownership).ownership, [{ windowId: 1, clients: 1 }])
    ws2.close()
  } finally {
    release()
    await close()
  }
})
