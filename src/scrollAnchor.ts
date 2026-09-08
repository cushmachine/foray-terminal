// Scroll anchoring for the scrollback history.
//
// A reconnect replaces the whole history with a fresh copy from tmux. The
// pixel scroll position survives that swap, but the text under it does not
// when lines were trimmed from the top meanwhile (the client keeps only the
// last MAX_HISTORY_LINES). So the row at the top of the viewport is
// remembered by its text before the swap and found again after it.

/** The row at the top of the viewport before a history swap. */
export interface RowAnchor {
  /** Index of the row in the old history. */
  index: number
  /** Text of that row and the rows right after it; the run makes it unique. */
  texts: string[]
  /** Pixels of the row already scrolled past above the viewport top. */
  offset: number
}

/** How many rows make up an anchor's signature. */
export const ANCHOR_ROWS = 3

/**
 * Index in `rows` of the anchor's signature, or -1. Searches outward from
 * the old index so the nearest match wins when the run repeats. A run with
 * no text at all (blank lines) is ambiguous and never matches.
 *
 * The signature is compared as one joined string, ending at a row
 * boundary: a line that was still being wrapped onto the screen reaches
 * the client in pieces (its history part, then the extension as a row of
 * its own) and a reset delivers it joined, so the rows may have merged or
 * split between the capture and the search.
 */
export function findAnchorRow(rows: string[], anchor: Pick<RowAnchor, 'index' | 'texts'>): number {
  const { texts } = anchor
  if (texts.length === 0 || texts.every((t) => t.trim() === '')) return -1
  const last = rows.length - 1
  if (last < 0) return -1
  const signature = texts.join('')
  const matches = (i: number): boolean => {
    let joined = ''
    for (let k = i; k <= last && joined.length < signature.length; k++) joined += rows[k]
    return joined === signature
  }
  const start = Math.min(Math.max(anchor.index, 0), last)
  for (let d = 0; start - d >= 0 || start + d <= last; d++) {
    if (start - d >= 0 && matches(start - d)) return start - d
    if (d > 0 && start + d <= last && matches(start + d)) return start + d
  }
  return -1
}
