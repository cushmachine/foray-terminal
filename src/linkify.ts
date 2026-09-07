// Turn URLs inside rendered history rows into anchors.
//
// History arrives one screen row per div. A phone's narrow columns wrap most
// URLs, so a match that runs to the very end of a row is joined with the
// leading non-space run of the next row (repeating while whole rows are
// consumed); both fragments get an anchor with the joined href.
import { URL_RE, cleanUrl } from './links'

const LEADING_RUN = /^[^\s]+/

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
  a.rel = 'noopener'
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

/** Wrap a run at the start of `row`'s first text node. */
function wrapLeadingRun(row: HTMLElement, href: string): number {
  const first = textNodesOf(row)[0]
  if (!first) return 0
  const m = LEADING_RUN.exec(first.data)
  if (!m) return 0
  wrapRange(first, 0, m[0].length, href)
  return m[0].length
}

/**
 * `cols` is the pane width: a URL only continues onto the next row when the
 * row it fills is exactly full — that's the one signature of a soft wrap.
 * Without it, any URL that happens to end a line would swallow the first
 * word of the line below.
 */
export function linkifyRows(rows: HTMLElement[], cols: number): void {
  // Rows whose leading run was consumed by a wrapped URL from above; the
  // consumed prefix must not be matched again.
  const consumed = new Map<HTMLElement, number>()
  const isFull = (el: HTMLElement) => (el.textContent ?? '').length >= cols

  rows.forEach((row, i) => {
    const rowText = row.textContent ?? ''
    for (const node of textNodesOf(row)) {
      // Offset of this node within the row's text, to know when a match
      // reaches the row end.
      let nodeStart = 0
      for (const t of textNodesOf(row)) {
        if (t === node) break
        nodeStart += t.data.length
      }
      const skip = consumed.get(row) ?? 0
      let cursor: Text | null = node
      while (cursor) {
        URL_RE.lastIndex = 0
        const data = cursor.data
        const from = Math.max(0, skip - nodeStart)
        URL_RE.lastIndex = from
        const m = URL_RE.exec(data)
        if (!m) break
        const start = m.index
        let end = start + m[0].length
        let href = m[0]

        // Wrapped continuation: the match reaches the row's end.
        const reachesEnd = nodeStart + end >= rowText.length && end === data.length
        let j = i + 1
        const continuations: HTMLElement[] = []
        if (reachesEnd && isFull(row)) {
          while (j < rows.length) {
            const next = rows[j]
            const nextText = next.textContent ?? ''
            const run = LEADING_RUN.exec(nextText)
            if (!run) break
            href += run[0]
            continuations.push(next)
            if (run[0].length < nextText.length || !isFull(next)) break
            j++
          }
        }

        const cleaned = cleanUrl(href)
        // Trailing punctuation lives in the last fragment; trim it there.
        const trimmed = href.length - cleaned.length
        if (continuations.length === 0) end -= trimmed
        href = cleaned

        const tail = wrapRange(cursor, start, end, href)
        for (const c of continuations) consumed.set(c, wrapLeadingRun(c, href))
        nodeStart += end
        cursor = tail
      }
    }
  })
}
