// Pending for S8 (captureHistoryLines passes -J so tmux joins soft-wrapped rows).
//
// tmux stores a long line as several screen-width rows. Captured row by
// row, each arrives as its own history line and the client's own wrapping
// then breaks it a second time at a slightly different column, which is
// where the one-character orphan rows on a phone come from. capture-pane
// -J hands back the logical line.
//
// Run with: npx tsx --test src/server/__tests__/pending/history-join.test.ts

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { captureHistoryLines, type TmuxExecutor } from '../../tmux.ts'

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
