// Select mode: the terminal frozen as plain text so a phone can long-press
// select and copy any of it.
//
// A live terminal can't be selected natively. xterm's DOM renderer rewrites
// a row's elements whenever it changes, and a native selection is anchored
// to those elements, so Claude Code's constant redraws collapse it within a
// fraction of a second. xterm also takes the mousedown a long press turns
// into and focuses its textarea, which pops the keyboard. Every mobile
// terminal that solves this does it the same way: snapshot the text into a
// static element the browser owns, select there, then return to the live
// screen. This module is the pure part; overlays.tsx renders the overlay.

import { joinWrapped } from './links'

/** Scrollback rows followed by the screen's logical lines, trailing blanks dropped. */
export function snapshotText(history: string[], screen: string[]): string {
  const lines = [...history, ...screen]
  let end = lines.length
  while (end > 0 && lines[end - 1].trim() === '') end--
  return lines.slice(0, end).join('\n')
}

/** What the screen walk needs of the xterm. */
export interface ScreenLines {
  readonly rows: number
  readonly buffer: {
    readonly active: {
      getLine(y: number): { translateToString(trim?: boolean): string; isWrapped: boolean } | undefined
    }
  }
}

/** The visible screen as logical lines: rows xterm soft-wrapped are rejoined. */
export function visibleLogicalLines(term: ScreenLines): string[] {
  const buffer = term.buffer.active
  const rows: { text: string; wrapped: boolean }[] = []
  for (let i = 0; i < term.rows; i++) {
    const line = buffer.getLine(i)
    if (line) rows.push({ text: line.translateToString(true), wrapped: line.isWrapped })
  }
  return joinWrapped(rows)
}
