// Pure helpers for deciding when a terminal may be fitted and when a new
// size is worth telling the server about. Kept free of DOM and xterm so
// they can be unit tested; Terminal.tsx wires them to the real container.

export interface TerminalDims {
  cols: number
  rows: number
}

/**
 * True when the container has a real size. A terminal hidden with
 * `display: none` reports 0x0, and fitting it then is actively harmful:
 * the fit addon parses the container's computed "100%" height as 100
 * pixels and shrinks the pty to a few rows, which tmux dutifully redraws.
 */
export function canFit(width: number, height: number): boolean {
  return width > 0 && height > 0
}

/**
 * The size to report, or null when it matches what was last reported. Every
 * resize the server receives becomes a SIGWINCH and a full tmux redraw, so
 * repeats (a ResizeObserver tick with no real change, say) are dropped.
 */
export function nextResize(
  last: TerminalDims | null,
  cols: number,
  rows: number,
): TerminalDims | null {
  if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 1 || rows < 1) return null
  if (last && last.cols === cols && last.rows === rows) return null
  return { cols, rows }
}
