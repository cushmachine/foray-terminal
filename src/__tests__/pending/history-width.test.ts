// Pending for S8 (history pane locked to exactly `cols` cells).
//
// The history pane is a div with pre-wrap and break-all whose width is
// whatever the flex layout gives it; the pty's width is `cols` cells. The
// two disagree by a fraction of a cell, so rows tmux already wrapped at
// `cols` wrap again one column short and leave a single-character orphan
// row. Expected in src/historyWidth.ts:
//
//   export function historyWidthPx(cols: number, cellWidthPx: number): number
//     the pane's inner width: exactly `cols` glyphs fit and `cols + 1` do
//     not, for fractional cell widths too
//   export function wrapAtCols(line: string, cols: number): string[]
//     the rows a `cols`-wide pane shows for a logical line (what tmux
//     does; used to check the pane against the pty)
//
// Skipped until the module exists; the body is written against that API.
//
// Run with: npx tsx --test src/__tests__/pending/history-width.test.ts

import { test } from 'node:test'
import assert from 'node:assert/strict'

interface HistoryWidth {
  historyWidthPx(cols: number, cellWidthPx: number): number
  wrapAtCols(line: string, cols: number): string[]
}

const MODULE = '../../historyWidth.ts'

async function load(): Promise<HistoryWidth> {
  return (await import(MODULE)) as HistoryWidth
}

test('historyWidthPx fits exactly cols glyphs for fractional cell widths', { skip: 'needs S8: src/historyWidth.ts' }, async () => {
  const { historyWidthPx } = await load()
  for (const [cols, cell] of [[48, 7.8], [80, 8.4], [47, 7.203125], [200, 9]] as const) {
    const width = historyWidthPx(cols, cell)
    assert.ok(width >= cols * cell, `${cols}x${cell}: ${width}px is narrower than ${cols} cells`)
    assert.ok(width < (cols + 1) * cell, `${cols}x${cell}: ${width}px fits a ${cols + 1}th cell`)
  }
})

test('wrapAtCols splits a logical line the way the pty does', { skip: 'needs S8: src/historyWidth.ts' }, async () => {
  const { wrapAtCols } = await load()
  const line = 'wrap'.repeat(50) // 200 chars
  const rows = wrapAtCols(line, 48)
  assert.deepEqual(rows.map((r) => r.length), [48, 48, 48, 48, 8])
  assert.equal(rows.join(''), line)
  assert.deepEqual(wrapAtCols('', 48), [''])
  assert.deepEqual(wrapAtCols('short', 48), ['short'])
})
