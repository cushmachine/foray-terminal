// The scrollback pane as DOM: one div per history line, colour escapes
// rendered to spans, URLs made clickable, and the pane's width locked to
// the pty's columns. The controller owns the line count and the cap; this
// owns the elements.

import { ansiLineToHtml, plainStyle, type Palette, type Style } from '../ansi'
import { historyWidthPx } from '../historyWidth'
import { linkifyRows } from '../linkify'
import type { HistoryPane } from './TerminalController'

export function createHistoryPane(el: HTMLElement, palette: Palette): HistoryPane {
  // The style in force at the end of the last row: tmux writes a colour
  // code only where the colour changes, so the next row starts from here.
  let carry: Style = plainStyle()
  return {
    get rows() {
      return el.children
    },
    append(lines) {
      const rows: HTMLElement[] = []
      for (const line of lines) {
        const row = document.createElement('div')
        // An empty div collapses to nothing; a no-break space keeps the row's height.
        row.innerHTML = ansiLineToHtml(line, palette, carry) || '&nbsp;'
        rows.push(row)
      }
      linkifyRows(rows)
      el.append(...rows)
    },
    trimTop(count) {
      for (let i = 0; i < count && el.firstChild; i++) el.removeChild(el.firstChild)
    },
    clear() {
      el.replaceChildren()
      carry = plainStyle()
    },
    lockWidth(cols) {
      // A probe in the pane's own font: what `cols` glyphs measure here,
      // not in xterm, whose renderer rounds the same font its own way.
      const probe = document.createElement('span')
      probe.style.whiteSpace = 'pre'
      probe.textContent = '0'.repeat(cols)
      el.appendChild(probe)
      const width = probe.getBoundingClientRect().width
      probe.remove()
      if (width <= 0) return
      // The pane keeps its full width and the right padding takes up what
      // is left over, so nothing sticks out of the scroll container.
      const inner = historyWidthPx(cols, width / cols)
      const left = parseFloat(getComputedStyle(el).paddingLeft) || 0
      el.style.paddingRight = `${Math.max(0, el.clientWidth - left - inner)}px`
    },
  }
}
