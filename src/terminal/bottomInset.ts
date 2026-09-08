// Composer mode on a phone: how much of the live screen to park below the
// fold. With the Composer focused the user types there, not at the prompt,
// so the prompt box, the status line and any trailing blanks under the
// last real output row can sit under the keyboard while that output row
// meets the viewport's bottom edge.

/** Rows that are chrome, not output: Claude Code's box-drawing separators and its prompt. */
const SEPARATOR = /^[\s─━═╌┄]+$/
const PROMPT = /^\s*❯/

/** What the walk needs of the xterm: its buffer and, for measuring, its element. */
export interface ScreenTerm {
  readonly rows: number
  readonly element: HTMLElement | undefined
  readonly buffer: {
    readonly active: {
      readonly baseY: number
      readonly cursorY: number
      getLine(y: number): { translateToString(trim?: boolean): string } | undefined
    }
  }
}

/** Whether the Composer, or something inside it, has focus. */
export function composerFocused(): boolean {
  return document.querySelector('[data-composer]:focus-within') !== null
}

/**
 * Pixels of the screen below the last real output row. The cursor row is
 * never output, so the walk starts above it.
 */
export function bottomInset(term: ScreenTerm, scrollEl: HTMLElement): number {
  const buf = term.buffer.active
  const text = (r: number) => buf.getLine(r)?.translateToString(true) ?? ''
  let row = buf.baseY + buf.cursorY - 1
  while (row >= 0) {
    const t = text(row)
    if (t !== '' && !SEPARATOR.test(t) && !PROMPT.test(t)) break
    row--
  }
  const outputRow = row - buf.baseY
  // Measure rather than assume: the DOM renderer keeps one div per row in
  // .xterm-rows, and xterm's screen can overflow the container's padding.
  const rowEl = term.element?.querySelector('.xterm-rows')?.children[outputRow] as HTMLElement | undefined
  if (rowEl) {
    const rowBottom = rowEl.getBoundingClientRect().bottom - scrollEl.getBoundingClientRect().top + scrollEl.scrollTop
    return Math.max(0, scrollEl.scrollHeight - rowBottom)
  }
  // No output row on screen (or no DOM rows): park the whole screen.
  const screen = term.element?.querySelector<HTMLElement>('.xterm-screen')
  const cellH = screen ? screen.clientHeight / Math.max(term.rows, 1) : 0
  return (term.rows - outputRow - 1) * cellH
}
