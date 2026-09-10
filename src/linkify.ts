// Turn URLs inside rendered history rows into anchors.
//
// A history row is one line as the program wrote it (the server captures
// tmux's history with wrapped rows joined), so a URL is whole within its
// row however narrow the pane; the pane wraps it as it wraps any text.
import { URL_RE, cleanUrl } from './urls'

function textNodesOf(el: HTMLElement): Text[] {
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
  const nodes: Text[] = []
  let n: Node | null
  while ((n = walker.nextNode())) nodes.push(n as Text)
  return nodes
}

function anchor(href: string, label: string): HTMLAnchorElement {
  const a = document.createElement('a')
  a.className = 'term-link'
  a.href = href
  a.target = '_blank'
  a.rel = 'noopener noreferrer'
  a.textContent = label
  return a
}

/** Wrap [start, end) of `node` in an anchor. Returns the split-off tail node, if any. */
function wrapRange(node: Text, start: number, end: number, href: string): Text | null {
  const tail = end < node.data.length ? node.splitText(end) : null
  const target = start > 0 ? node.splitText(start) : node
  const a = anchor(href, target.data)
  target.parentNode?.replaceChild(a, target)
  return tail
}

/** Anchor every URL in each row. A URL split across colour spans is matched within each. */
export function linkifyRows(rows: HTMLElement[]): void {
  for (const row of rows) {
    for (const node of textNodesOf(row)) {
      let cursor: Text | null = node
      while (cursor) {
        URL_RE.lastIndex = 0
        const m = URL_RE.exec(cursor.data)
        if (!m) break
        const href = cleanUrl(m[0])
        cursor = wrapRange(cursor, m.index, m.index + href.length, href)
      }
    }
  }
}
