// URL helpers for terminal text. Pure, no DOM, so they run under node tests.
// The terminal shows URLs as text; on a phone that text wraps and can't be
// selected precisely, so Terminal.tsx surfaces them as tappable chips.

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

/** URLs in `text`, deduped, first-occurrence order. */
export function extractUrls(text: string): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const m of text.matchAll(URL_RE)) {
    const url = cleanUrl(m[0])
    if (!url || seen.has(url)) continue
    seen.add(url)
    out.push(url)
  }
  return out
}

/**
 * Chip label: scheme dropped, host + path, middle-ellipsised to `max`
 * characters so the host and the tail (usually the interesting token) both
 * survive.
 */
export function shortenUrl(url: string, max = 40): string {
  const label = url.replace(/^https?:\/\//, '')
  if (label.length <= max) return label
  const keep = max - 1
  const head = Math.ceil(keep / 2)
  const tail = keep - head
  return `${label.slice(0, head)}…${label.slice(label.length - tail)}`
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
