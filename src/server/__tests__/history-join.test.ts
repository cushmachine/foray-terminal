// Scrollback lines come from tmux joined (capture-pane -J): a line the
// program wrote is one entry however many rows tmux showed it on, so the
// client wraps it once, at its own width, instead of again on top of
// tmux's break. The fake tmux keeps rows plus which of them are wrapped,
// and joins them the way tmux does: only within the captured range, and
// with a newline after the last row even when it continues onto the
// visible screen.
//
// Run with: npx tsx --test src/server/__tests__/history-join.test.ts

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { captureHistoryLines, type TmuxExecutor } from '../tmux.ts'
import { fakeTmux, handleTestConnection, until } from './helpers.ts'

test('captureHistoryLines asks tmux to join wrapped rows', async () => {
  const calls: string[][] = []
  const exec: TmuxExecutor = async (_cmd, args) => {
    calls.push(args)
    return { stdout: 'one logical line that tmux showed on two rows\nanother\n', stderr: '' }
  }
  const lines = await captureHistoryLines(3, 2, exec)

  const capture = calls.find((args) => args[0] === 'capture-pane')
  assert.ok(capture, 'capture-pane was called')
  assert.ok(capture.includes('-J'), `capture-pane argv lacks -J: ${capture.join(' ')}`)
  assert.deepEqual(lines, ['one logical line that tmux showed on two rows', 'another'])
})

test('the fake tmux joins wrapped rows within the captured range only', async () => {
  const tmux = fakeTmux()
  tmux.add('shell', { history: ['aaaa', 'bbbb', 'cc', 'd', 'eeee'], wrapped: [0, 1, 4] })
  assert.deepEqual(await captureHistoryLines(0, 5, tmux.exec), ['aaaabbbbcc', 'd', 'eeee'])
  // A range starting on a continuation row gets the fragment, as tmux gives it.
  assert.deepEqual(await captureHistoryLines(0, 4, tmux.exec), ['bbbbcc', 'd', 'eeee'])
})

/** Send an attach and let the history land. */
async function attach(conn: ReturnType<typeof handleTestConnection>): Promise<void> {
  conn.socket.receive({ type: 'terminal:attach', windowId: 0, cols: 20, rows: 5 })
  await until(() => conn.ptys.length === 1, 'the pty to spawn')
}

const histories = (conn: ReturnType<typeof handleTestConnection>) =>
  conn.sent.filter((m) => m.type === 'terminal:history')

// A long line scrolls into history one row at a time. Each capture shows
// the line as far as it has got; the client gets the rows as they arrive,
// never a reset and never a repeat.
test('a line wrapped over the history boundary arrives row by row and is joined in the tail', async () => {
  const conn = handleTestConnection()
  const session = conn.tmux.add('shell', { history: ['$ cat file', 'xxxxxxxxxxxxxxxxxxxx'], wrapped: [1] })
  await attach(conn)
  assert.deepEqual(histories(conn).map((m) => m.lines), [['$ cat file', 'xxxxxxxxxxxxxxxxxxxx']])

  // The next row scrolls up: the same line, longer.
  session.history.push('yyyyyyyyyyyyyyyyyyyy')
  session.wrapped.push(2)
  conn.ptys[0].emit('scroll')
  await until(() => histories(conn).length === 2, 'a second history message')
  assert.deepEqual(histories(conn)[1], {
    type: 'terminal:history', windowId: 0, lines: ['yyyyyyyyyyyyyyyyyyyy'], reset: false,
  })

  // Its last row, plus a whole new line.
  session.history.push('zz', '$ ')
  conn.ptys[0].emit('scroll')
  await until(() => histories(conn).length === 3, 'a third history message')
  assert.deepEqual(histories(conn)[2], { type: 'terminal:history', windowId: 0, lines: ['zz', '$ '], reset: false })

  // Nothing since: a check finds nothing to send.
  conn.ptys[0].emit('idle')
  await new Promise((resolve) => setTimeout(resolve, 150))
  assert.equal(histories(conn).length, 3)
  conn.socket.emit('close')
})

// tmux reflows wrapped rows when the pane changes width, so the row count
// moves while the joined lines stay the same. That must not cost a reset.
test('a reflow that changes the row count but not the lines sends nothing', async () => {
  const conn = handleTestConnection()
  const session = conn.tmux.add('shell', { history: ['one', 'aaaabbbb', 'two'] })
  await attach(conn)
  assert.equal(histories(conn).length, 1)

  // Narrower: the middle line now takes two rows.
  session.history.splice(1, 1, 'aaaa', 'bbbb')
  session.wrapped.push(1)
  conn.socket.receive({ type: 'terminal:resize', windowId: 0, cols: 4, rows: 5 })
  conn.ptys[0].emit('redraw')
  await new Promise((resolve) => setTimeout(resolve, 250))
  assert.equal(histories(conn).length, 1, 'no history message for a narrower reflow')

  // Wider again: back to one row, so the history shrank.
  session.history.splice(1, 2, 'aaaabbbb')
  session.wrapped.length = 0
  conn.socket.receive({ type: 'terminal:resize', windowId: 0, cols: 40, rows: 5 })
  conn.ptys[0].emit('redraw')
  await new Promise((resolve) => setTimeout(resolve, 250))
  assert.equal(histories(conn).length, 1, 'no history message for a wider reflow')

  // A real new line after all that still arrives as an append.
  session.history.push('three')
  conn.ptys[0].emit('out')
  await until(() => histories(conn).length === 2, 'a second history message')
  assert.deepEqual(histories(conn)[1], { type: 'terminal:history', windowId: 0, lines: ['three'], reset: false })
  conn.socket.emit('close')
})

// Rows coming back from history to a taller screen leave the client
// showing lines that are now on the screen too; only a reset fixes that.
test('a history that lost its newest lines resets', async () => {
  const conn = handleTestConnection()
  const session = conn.tmux.add('shell', { history: ['one', 'two', 'three', 'four', 'five'] })
  await attach(conn)
  session.history.splice(3)
  conn.socket.receive({ type: 'terminal:resize', windowId: 0, cols: 20, rows: 7 })
  conn.ptys[0].emit('redraw')
  await until(() => histories(conn).length === 2, 'a second history message')
  assert.deepEqual(histories(conn)[1], {
    type: 'terminal:history', windowId: 0, lines: ['one', 'two', 'three'], reset: true,
  })
  conn.socket.emit('close')
})
