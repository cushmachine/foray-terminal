// Select mode: the screen's rows re-joined into logical lines, then the
// snapshot of scrollback plus screen with trailing blank rows dropped.
//
// Run with: npx tsx --test src/__tests__/select-mode.test.ts

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { joinWrapped, snapshotText } from '../selectMode.ts'

test('snapshotText: history precedes the screen, one line each', () => {
  assert.equal(snapshotText(['old 1', 'old 2'], ['now 1', 'now 2']), 'old 1\nold 2\nnow 1\nnow 2')
})

test('snapshotText: trailing blank and whitespace-only rows are dropped', () => {
  assert.equal(snapshotText(['a'], ['b', '', '   ', '']), 'a\nb')
})

test('snapshotText: blank rows in the middle are kept', () => {
  assert.equal(snapshotText(['a', '', 'b'], ['', 'c']), 'a\n\nb\n\nc')
})

test('snapshotText: an all-blank terminal gives an empty string', () => {
  assert.equal(snapshotText([], ['', '']), '')
  assert.equal(snapshotText([], []), '')
})

test('snapshotText: a screen alone, no scrollback', () => {
  assert.equal(snapshotText([], ['only']), 'only')
})

// ---------------------------------------------------------------------------
// joinWrapped
// ---------------------------------------------------------------------------

test('joinWrapped: a three-row wrap becomes one logical line', () => {
  const rows = [
    { text: 'Opening https://example.com/app/auth/', wrapped: false },
    { text: 'cli/abcdefghijklmnopqrstuvwxyz0123456789', wrapped: true },
    { text: 'ABCDEFGHIJ for login', wrapped: true },
  ]
  assert.deepEqual(joinWrapped(rows), [
    'Opening https://example.com/app/auth/cli/abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJ for login',
  ])
})

test('joinWrapped: unwrapped rows stay separate', () => {
  const rows = [
    { text: 'one', wrapped: false },
    { text: 'two', wrapped: false },
    { text: 'three', wrapped: false },
  ]
  assert.deepEqual(joinWrapped(rows), ['one', 'two', 'three'])
})

test('joinWrapped: wraps join only to their own line', () => {
  const rows = [
    { text: 'alpha-', wrapped: false },
    { text: 'beta', wrapped: true },
    { text: 'gamma', wrapped: false },
    { text: 'delta-', wrapped: false },
    { text: 'epsilon', wrapped: true },
  ]
  assert.deepEqual(joinWrapped(rows), ['alpha-beta', 'gamma', 'delta-epsilon'])
})

test('joinWrapped: empty input gives an empty list', () => {
  assert.deepEqual(joinWrapped([]), [])
})
