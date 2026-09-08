// Scroll anchoring across a history swap: the anchor row is found again by
// its text, nearest to where it was.
//
// Run with: npx tsx src/__tests__/scroll-anchor.test.ts

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { findAnchorRow } from '../scrollAnchor.ts'

const rows = (n: number, from = 1) => Array.from({ length: n }, (_, i) => String(from + i))

test('findAnchorRow: unchanged history gives the same index', () => {
  assert.equal(findAnchorRow(rows(100), { index: 40, texts: ['41', '42', '43'] }), 40)
})

test('findAnchorRow: rows trimmed from the top move the anchor up', () => {
  // 25 lines dropped from the top, 25 appended at the bottom.
  assert.equal(findAnchorRow(rows(100, 26), { index: 40, texts: ['41', '42', '43'] }), 15)
})

test('findAnchorRow: rows added above move the anchor down', () => {
  assert.equal(findAnchorRow(['x', 'y', ...rows(100)], { index: 40, texts: ['41', '42', '43'] }), 42)
})

test('findAnchorRow: the nearest of several matches wins', () => {
  const r = ['a', 'b', 'c', 'z', 'z', 'z', 'a', 'b', 'c']
  assert.equal(findAnchorRow(r, { index: 5, texts: ['a', 'b', 'c'] }), 6)
  assert.equal(findAnchorRow(r, { index: 2, texts: ['a', 'b', 'c'] }), 0)
})

test('findAnchorRow: a run of blank rows never matches', () => {
  assert.equal(findAnchorRow(['', '', '', ''], { index: 1, texts: ['', '', ''] }), -1)
  assert.equal(findAnchorRow(['', '', '', ''], { index: 1, texts: ['', '  '] }), -1)
})

test('findAnchorRow: gone from the history gives -1', () => {
  assert.equal(findAnchorRow(rows(100, 200), { index: 40, texts: ['41', '42', '43'] }), -1)
  assert.equal(findAnchorRow([], { index: 0, texts: ['41'] }), -1)
})

test('findAnchorRow: a short signature at the end of the history', () => {
  assert.equal(findAnchorRow(rows(10), { index: 9, texts: ['10'] }), 9)
  assert.equal(findAnchorRow(rows(10), { index: 50, texts: ['9', '10'] }), 8)
})
