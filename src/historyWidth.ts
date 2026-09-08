// The scrollback pane's width, in the pane's own terms.
//
// tmux breaks a line at the pty's column, and a program such as Claude Code
// writes rows exactly that wide. The pane shows those rows as wrapped
// text, so its inner width must hold exactly `cols` glyphs: a fraction of
// a cell short and every full row wraps again, leaving a one- or
// two-character orphan on the next line. The pane measures its own font
// (a probe of `cols` characters), not xterm's cell, since the two engines
// can round the same font differently.

/**
 * Slack past the `cols` glyphs, so the browser's subpixel rounding of
 * the run never wraps the last one, capped so the pane's right padding
 * (8px) always absorbs it and the pane stays inside its container.
 */
const SLACK_PX = 4

/**
 * Inner width for a pane that must fit `cols` glyphs of `cellWidthPx`
 * each and not one more.
 */
export function historyWidthPx(cols: number, cellWidthPx: number): number {
  return cols * cellWidthPx + Math.min(cellWidthPx / 2, SLACK_PX)
}

/**
 * The rows a `cols`-wide pane shows for a logical line: what tmux does
 * with a line wider than the pty, and what the pane must do with the
 * joined line it is sent. Used to check the pane against the pty.
 */
export function wrapAtCols(line: string, cols: number): string[] {
  if (line.length <= cols) return [line]
  const rows: string[] = []
  for (let at = 0; at < line.length; at += cols) rows.push(line.slice(at, at + cols))
  return rows
}
