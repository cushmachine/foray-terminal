// Select mode snapshot: scrollback then screen, trailing blank rows dropped.
//
// Run with: npx tsx src/__tests__/select-mode.test.ts

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { snapshotText } from '../selectMode.ts'

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
