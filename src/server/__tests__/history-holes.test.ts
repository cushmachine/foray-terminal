// Holes in the client's scrollback. A line the server skips is gone for
// good: `known` moves past it and every later sync appends from after it,
// so the browser keeps a scrollback with a gap in the middle that tmux
// itself does not have. Two ways that happened, both found by driving
// this handler against a real tmux (src/e2e) and reproduced here.
//
// Run with: npx tsx --test src/server/__tests__/history-holes.test.ts

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fakeTmux, handleTestConnection, until, type Msg } from './helpers.ts'
import type { TmuxExecutor } from '../tmux.ts'

type Conn = ReturnType<typeof handleTestConnection>

/** Send an attach and let the history land. */
async function attach(conn: Conn): Promise<void> {
  conn.socket.receive({ type: 'terminal:attach', windowId: 0, cols: 20, rows: 5 })
  await until(() => conn.ptys.length === 1, 'the pty to spawn')
}

/** The scrollback the browser ends up holding: reset replaces, otherwise append. */
function clientHistory(conn: Conn): string[] {
  const lines: string[] = []
  for (const msg of conn.sent as Msg[]) {
    if (msg.type !== 'terminal:history') continue
    if (msg.reset) lines.length = 0
    lines.push(...(msg.lines as string[]))
  }
  return lines
}

// Terminals repeat themselves. When the run the client ends on turns up
// twice in one capture, the newer occurrence is the wrong place to append
// from: every line between the two is dropped and never captured again.
test('lines between two copies of the sent tail reach the client', async () => {
  const conn = handleTestConnection()
  const session = conn.tmux.add('shell', { history: ['a', 'b', 'c'] })
  await attach(conn)
  assert.deepEqual(clientHistory(conn), ['a', 'b', 'c'])

  // A burst that ends by printing the same three lines the client ends on.
  session.history.push('ROW-06', 'ROW-07', 'a', 'b', 'c', 'z')
  conn.ptys[0].emit('out')
  await until(() => clientHistory(conn).length === session.history.length, 'the client to catch up')
  assert.deepEqual(clientHistory(conn), session.history, 'no line may be skipped')
  conn.socket.emit('close')
})

// The size and the rows are two tmux calls, and the pane keeps printing
// between them. Asking for exactly the size read first hands back a window
// that starts after the client's oldest line, which a reset then throws away.
test('a history that grew while tmux answered keeps its oldest lines', async () => {
  const tmux = fakeTmux()
  const session = tmux.add('shell', { history: ['one', 'two', 'three'] })
  const racing: TmuxExecutor = async (cmd, args) => {
    const result = await tmux.exec(cmd, args)
    // Two more rows scroll into history the moment the size has been read.
    if (args[0] === 'display-message' && session.history.length === 3) session.history.push('four', 'five')
    return result
  }
  const conn = handleTestConnection({ tmuxExec: racing })
  await attach(conn)

  assert.deepEqual(clientHistory(conn), ['one', 'two', 'three', 'four', 'five'])
  conn.socket.emit('close')
})
