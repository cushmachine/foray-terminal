// URLs in terminal text. Pure, no DOM, so it runs under node tests.
// linkify.ts anchors URLs in scrollback with these; useTerminal.ts gives
// the same pattern to xterm's link addon so the live screen and the
// scrollback agree on where a URL starts and ends.

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
