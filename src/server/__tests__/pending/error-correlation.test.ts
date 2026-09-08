// Pending for S4 (ErrorMessage gains `request`, `windowId`, `path`).
//
// An error message names the request it answers, so the file panel can
// tell its own failures from the terminal's and a terminal only reacts to
// errors about its window. Today every error is a bare `{ type, message }`
// and each consumer shows all of them.
//
// Run with: npx tsx --test src/server/__tests__/pending/error-correlation.test.ts

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { connect, startTestServer, waitForType } from '../helpers.ts'

test('an error from files:read names the request and the path', async () => {
  const { url, close } = await startTestServer()
  try {
    const { ws } = await connect(url)
    const error = waitForType(ws, 'error')
    ws.send(JSON.stringify({ type: 'files:read', path: '../etc/passwd' }))
    const err = await error
    assert.equal(err.request, 'files:read')
    assert.equal(err.path, '../etc/passwd')
    ws.close()
  } finally {
    await close()
  }
})

test('an error from terminal:attach names the request and the window', async () => {
  const { url, close, tmux } = await startTestServer({
    ptySpawner: () => {
      throw new Error('no pty for you')
    },
  })
  tmux.add('shell')
  try {
    const { ws } = await connect(url)
    const error = waitForType(ws, 'error')
    ws.send(JSON.stringify({ type: 'terminal:attach', windowId: 0 }))
    const err = await error
    assert.equal(err.request, 'terminal:attach')
    assert.equal(err.windowId, 0)
    ws.close()
  } finally {
    await close()
  }
})
