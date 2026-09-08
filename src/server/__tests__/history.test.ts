// Scrollback from tmux history: the pure decisions behind fetching history.
// What to fetch given what the client already has (planHistoryUpdate), how
// to find the new lines in a fresh capture (alignHistory), and what to
// remember for the next alignment (nextTail). No tmux involved; the CLI
// wrapper is covered in tmux-and-routing.test.ts.
//
// Run with: npx tsx --test src/server/__tests__/history.test.ts

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  planHistoryUpdate,
  alignHistory,
  nextTail,
  SATURATED_WINDOW,
  type PaneHistoryState,
} from '../history.ts'

/** A pane well below its limit, on the main screen, unless overridden. */
function state(size: number, overrides: Partial<PaneHistoryState> = {}): PaneHistoryState {
  return { size, limit: 2000, alternate: false, ...overrides }
}

/** Lines l<from>..l<to>, oldest first. */
function lines(from: number, to: number): string[] {
  const out: string[] = []
  for (let i = from; i <= to; i++) out.push(`l${i}`)
  return out
}

// ---------------------------------------------------------------------------
// planHistoryUpdate
// ---------------------------------------------------------------------------

test('planHistoryUpdate does nothing while the alternate screen is on', () => {
  // History is frozen behind a full-screen app, whatever the client has.
  assert.deepEqual(planHistoryUpdate(10, state(20, { alternate: true })), { kind: 'none' })
  assert.deepEqual(planHistoryUpdate(null, state(20, { alternate: true })), { kind: 'none' })
})

test('planHistoryUpdate resets when nothing has been sent', () => {
  assert.deepEqual(planHistoryUpdate(null, state(120)), { kind: 'reset' })
  // Even an empty history: the client may hold lines from a previous attach.
  assert.deepEqual(planHistoryUpdate(null, state(0)), { kind: 'reset' })
})

test('planHistoryUpdate checks a window of the tail when the history shrank', () => {
  // A resize reflow moves the row count without changing the joined lines,
  // so they are aligned first; a cleared history fails to align and resets.
  assert.deepEqual(planHistoryUpdate(120, state(90)), { kind: 'sync', count: 90 })
  assert.deepEqual(planHistoryUpdate(1000, state(600)), { kind: 'sync', count: SATURATED_WINDOW })
  assert.deepEqual(planHistoryUpdate(120, state(0)), { kind: 'sync', count: 0 })
})

test('planHistoryUpdate checks a window of the tail once the history is at its limit', () => {
  assert.deepEqual(planHistoryUpdate(2000, state(2000)), { kind: 'sync', count: SATURATED_WINDOW })
  // The size never moves again, so growth can no longer be read off it.
  assert.deepEqual(planHistoryUpdate(2000, state(2010)), { kind: 'sync', count: SATURATED_WINDOW })
  // A limit smaller than the window: never ask for more than exists.
  assert.deepEqual(planHistoryUpdate(50, state(50, { limit: 50 })), { kind: 'sync', count: 50 })
  assert.deepEqual(planHistoryUpdate(2000, state(2000), 10), { kind: 'sync', count: 10 })
})

test('planHistoryUpdate does nothing when the size has not moved', () => {
  assert.deepEqual(planHistoryUpdate(120, state(120)), { kind: 'none' })
})

test('planHistoryUpdate syncs the delta when the history grew', () => {
  assert.deepEqual(planHistoryUpdate(100, state(130)), { kind: 'sync', count: 30 })
  // An unknown limit (0) is not saturation.
  assert.deepEqual(planHistoryUpdate(100, state(130, { limit: 0 })), { kind: 'sync', count: 30 })
})

// ---------------------------------------------------------------------------
// alignHistory
// ---------------------------------------------------------------------------

/** The lines an alignment would send. */
const fresh = (sent: string[], captured: string[]) => alignHistory(sent, captured)?.fresh ?? null

test('alignHistory returns only the lines after what was already sent', () => {
  assert.deepEqual(fresh(lines(1, 5), lines(1, 7)), ['l6', 'l7'])
  // The capture need not start where the sent tail starts.
  assert.deepEqual(fresh(lines(1, 5), lines(3, 7)), ['l6', 'l7'])
  // The tail carries on from what was sent.
  assert.deepEqual(alignHistory(lines(1, 5), lines(3, 7))?.tail, lines(1, 7))
})

test('alignHistory returns [] when nothing new has arrived', () => {
  assert.deepEqual(fresh(lines(1, 5), lines(3, 5)), [])
})

test('alignHistory returns null when the captured tail is entirely new', () => {
  // Too much arrived since the last check to know where to append.
  assert.equal(fresh(lines(1, 5), lines(20, 30)), null)
})

test('alignHistory returns null when nothing was ever sent', () => {
  assert.equal(fresh([], lines(1, 5)), null)
})

test('alignHistory finds the sent tail mid-window when history rotates at its limit', () => {
  // At the limit the size stops moving; the last sent lines sit somewhere
  // inside the captured window with the new lines after them.
  assert.deepEqual(fresh(lines(1, 10), lines(8, 17)), lines(11, 17))
})

test('alignHistory prefers the longest run when lines repeat', () => {
  // The last sent line also ends the capture. Matching only that line from
  // the newest end would report nothing new; the full run shows two lines
  // arrived.
  assert.deepEqual(fresh(['p', 'q', 'r'], ['p', 'q', 'r', 's', 'r']), ['s', 'r'])
})

test('alignHistory needs more than a one-line overlap when it has more to compare', () => {
  // Blank lines and prompts repeat; one matching line is no evidence.
  assert.equal(fresh(['a', 'b', 'c'], ['c', 'd', 'e']), null)
  // A short sent tail is all there is, so one line has to do.
  assert.deepEqual(fresh(['a'], ['a', 'b']), ['b'])
})

test('alignHistory lets the last sent line grow: a wrapped line still scrolling into history', () => {
  // The line was captured as far as it had got; now two more rows of it are in.
  const aligned = alignHistory(['a', 'b', 'xxxx'], ['a', 'b', 'xxxxyyyyzz', 'c'])
  assert.deepEqual(aligned?.fresh, ['yyyyzz', 'c'], 'only the new part goes to the client')
  assert.deepEqual(aligned?.tail, ['a', 'b', 'xxxxyyyyzz', 'c'], 'the tail remembers the joined line')
  // Growing again from that tail: the earlier rows are not repeated.
  assert.deepEqual(fresh(['a', 'b', 'xxxxyyyyzz', 'c'], ['b', 'xxxxyyyyzz', 'c']), [])
  assert.deepEqual(fresh(['a', 'b', 'xxxxyyyyzz'], ['a', 'b', 'xxxxyyyyzzw']), ['w'])
})

test('alignHistory does not let an empty or a shortened last line match by prefix', () => {
  // Every line starts with the empty string; a blank last line matches only itself.
  assert.equal(fresh(['a', 'b', ''], ['a', 'b', 'c']), null)
  // A line that came back shorter is on the screen again: nothing to append to.
  assert.equal(fresh(['a', 'b', 'xxxxyyyy'], ['a', 'b', 'xxxx']), null)
  // Only the last line may grow.
  assert.equal(fresh(['a', 'xxxx', 'c'], ['a', 'xxxxyy', 'c']), null)
})

// ---------------------------------------------------------------------------
// nextTail
// ---------------------------------------------------------------------------

test('nextTail keeps only the newest lines up to the cap', () => {
  assert.deepEqual(nextTail(['a', 'b', 'c'], ['d', 'e'], 4), ['b', 'c', 'd', 'e'])
  assert.deepEqual(nextTail([], ['a', 'b'], 50), ['a', 'b'])
  assert.deepEqual(nextTail(lines(1, 60), [], 50), lines(11, 60))
  assert.deepEqual(nextTail(['a'], ['b'], 5), ['a', 'b'])
})
