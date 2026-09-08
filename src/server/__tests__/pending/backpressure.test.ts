// Pending for S4 (pty backpressure against ws.bufferedAmount).
//
// A pane that floods output (cat of a big file, a runaway loop) fills the
// socket's send buffer faster than a phone drains it; the server keeps
// reading the pty and buffering in memory. Above a high-water mark the pty
// is paused, and resumed once the socket has drained. Today the pty is
// never paused.
//
// Run with: npx tsx --test src/server/__tests__/pending/backpressure.test.ts

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { handleTestConnection, until } from '../helpers.ts'

const CHUNK = 'x'.repeat(64 * 1024)
const CHUNKS = 80 // 5 MB

test('a flooding pty is paused while the socket buffer is high and resumed once drained', async () => {
  const conn = handleTestConnection()
  conn.tmux.add('shell')
  conn.socket.receive({ type: 'terminal:attach', windowId: 0 })
  await until(() => conn.ptys.length === 1, 'the pty to spawn')
  const pty = conn.ptys[0]

  // The client is not keeping up: the socket reports megabytes queued.
  conn.socket.bufferedAmount = 4 * 1024 * 1024
  for (let i = 0; i < CHUNKS; i++) pty.emit(CHUNK)
  assert.ok(pty.pauses > 0, 'pty.pause() while the socket has more than the high-water mark buffered')

  conn.socket.bufferedAmount = 0
  await until(() => pty.resumes > 0, 'pty.resume() once the socket drained')
  assert.equal(pty.resumes, pty.pauses, 'every pause is matched by one resume')
  conn.socket.emit('close')
})
