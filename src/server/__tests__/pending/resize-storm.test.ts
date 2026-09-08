// Pending for S4 (one reflow timer per attachment, reset on each resize).
//
// A phone rotating, or a desktop window being dragged, sends a burst of
// terminal:resize messages. tmux reflows the history after each, so the
// server re-sends the whole history once the burst settles. Today every
// resize arms its own timer and the client receives the full history once
// per resize: ten resizes, ten copies of up to 3000 lines.
//
// Run with: npx tsx --test src/server/__tests__/pending/resize-storm.test.ts

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { connect, startTestServer, waitForType, type Msg } from '../helpers.ts'

/** Every message of `type` that arrives within `ms`. */
function collect(ws: WebSocket, type: string, ms: number): Promise<Msg[]> {
  return new Promise((resolve) => {
    const seen: Msg[] = []
    const handler = (event: MessageEvent): void => {
      const msg = JSON.parse(String(event.data)) as Msg
      if (msg.type === type) seen.push(msg)
    }
    ws.addEventListener('message', handler)
    setTimeout(() => {
      ws.removeEventListener('message', handler)
      resolve(seen)
    }, ms)
  })
}

test('ten resizes in 50 ms cause one history re-send', async () => {
  const { url, close, tmux } = await startTestServer()
  tmux.add('shell', { history: ['one', 'two', 'three'] })
  try {
    const { ws } = await connect(url)
    const attached = waitForType(ws, 'terminal:history')
    ws.send(JSON.stringify({ type: 'terminal:attach', windowId: 0, cols: 80, rows: 24 }))
    await attached

    const resends = collect(ws, 'terminal:history', 700)
    for (let i = 0; i < 10; i++) {
      ws.send(JSON.stringify({ type: 'terminal:resize', windowId: 0, cols: 60 + i, rows: 24 }))
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    const got = await resends
    assert.equal(got.length, 1, `expected one history re-send after the storm, got ${got.length}`)
    assert.equal(got[0].reset, true)
    ws.close()
  } finally {
    await close()
  }
})
