// URL and row helpers for terminal text. Pure, no DOM, so they run under
// node tests. linkify.ts turns URLs in scrollback into anchors; Terminal.tsx
// uses joinWrapped to rebuild logical lines from wrapped screen rows.

export const URL_RE = /https?:\/\/[^\s<>"'`]+/g

const TRAILING_PUNCT = /[.,;:!?'"]+$/

/** Drop punctuation that follows a URL in prose, and an unbalanced closing paren. */
export function cleanUrl(raw: string): string {
  let url = raw.replace(TRAILING_PUNCT, '')
  while (url.endsWith(')')) {
    const opens = (url.match(/\(/g) ?? []).length
    const closes = (url.match(/\)/g) ?? []).length
    if (closes <= opens) break
    url = url.slice(0, -1).replace(TRAILING_PUNCT, '')
  }
  return url
}

/**
 * Join screen rows into logical lines: a row flagged `wrapped` is the
 * continuation of the row above it (xterm's isWrapped / tmux's soft wrap).
 */
export function joinWrapped(rows: { text: string; wrapped: boolean }[]): string[] {
  const out: string[] = []
  for (const row of rows) {
    if (row.wrapped && out.length > 0) out[out.length - 1] += row.text
    else out.push(row.text)
  }
  return out
}
