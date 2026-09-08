// The scrollback pane as DOM: one div per history line, colour escapes
// rendered to spans, URLs made clickable. The controller owns the line
// count and the cap; this owns the elements.

import { ansiLineToHtml, type Palette } from '../ansi'
import { linkifyRows } from '../linkify'
import type { HistoryPane } from './TerminalController'

export function createHistoryPane(el: HTMLElement, palette: Palette): HistoryPane {
  return {
    get rows() {
      return el.children
    },
    append(lines, cols) {
      const rows: HTMLElement[] = []
      for (const line of lines) {
        const row = document.createElement('div')
        // An empty div collapses to nothing; a no-break space keeps the row's height.
        row.innerHTML = ansiLineToHtml(line, palette) || '&nbsp;'
        rows.push(row)
      }
      linkifyRows(rows, cols)
      el.append(...rows)
    },
    trimTop(count) {
      for (let i = 0; i < count && el.firstChild; i++) el.removeChild(el.firstChild)
    },
    clear() {
      el.replaceChildren()
    },
  }
}
