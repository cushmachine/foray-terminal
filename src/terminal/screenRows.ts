// The live screen's rows above the cursor, as text and as positions in the
// scroll container, for the prompt jump: a prompt the user just submitted
// is still on the screen, not yet in the scrollback, and must be reachable.

import type { ScreenTerm } from './bottomInset'

export interface ScreenLines {
  /** Row text, top of the screen first, up to but not including the cursor row. */
  texts: string[]
  /** Content-relative top edge (pixels from the top of the scroll content) of row `index`. */
  rowTop(index: number): number
}

/** The cursor row is the input line, never output, so the rows end above it. */
export function screenLinesAboveCursor(term: ScreenTerm, scrollEl: HTMLElement): ScreenLines {
  const buf = term.buffer.active
  const texts: string[] = []
  for (let r = 0; r < buf.cursorY; r++) texts.push(buf.getLine(buf.baseY + r)?.translateToString(true) ?? '')
  return {
    texts,
    rowTop(index) {
      const base = scrollEl.getBoundingClientRect().top - scrollEl.scrollTop
      // Measure rather than assume where possible: the DOM renderer keeps
      // one div per row in .xterm-rows. The WebGL renderer has none, so the
      // row's place comes from the screen's height divided by its rows.
      const rowEl = term.element?.querySelector('.xterm-rows')?.children[index] as HTMLElement | undefined
      if (rowEl) return rowEl.getBoundingClientRect().top - base
      const screen = term.element?.querySelector<HTMLElement>('.xterm-screen')
      if (!screen) return 0
      const cellH = screen.clientHeight / Math.max(term.rows, 1)
      return screen.getBoundingClientRect().top - base + index * cellH
    },
  }
}
