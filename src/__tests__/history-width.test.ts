// The scrollback pane is locked to exactly `cols` cells (historyWidth.ts):
// a fraction of a cell narrower and every full row wraps again, leaving a
// one-character orphan line. historyWidthPx is the inner width for that;
// wrapAtCols is the pty's wrapping, for checking the pane against it.
//
// Run with: npx tsx --test src/__tests__/history-width.test.ts

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { historyWidthPx, wrapAtCols } from '../historyWidth.ts'

test('historyWidthPx fits exactly cols glyphs for fractional cell widths', () => {
  for (const [cols, cell] of [[48, 7.8], [80, 8.4], [47, 7.203125], [200, 9]] as const) {
    const width = historyWidthPx(cols, cell)
    assert.ok(width >= cols * cell, `${cols}x${cell}: ${width}px is narrower than ${cols} cells`)
    assert.ok(width < (cols + 1) * cell, `${cols}x${cell}: ${width}px fits a ${cols + 1}th cell`)
  }
})

test('wrapAtCols splits a logical line the way the pty does', () => {
  const line = 'wrap'.repeat(50) // 200 chars
  const rows = wrapAtCols(line, 48)
  assert.deepEqual(rows.map((r) => r.length), [48, 48, 48, 48, 8])
  assert.equal(rows.join(''), line)
  assert.deepEqual(wrapAtCols('', 48), [''])
  assert.deepEqual(wrapAtCols('short', 48), ['short'])
  // A row exactly as wide as the pty stays one row.
  assert.deepEqual(wrapAtCols('x'.repeat(48), 48), ['x'.repeat(48)])
})
