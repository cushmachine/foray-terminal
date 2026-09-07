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

// ---------------------------------------------------------------------------
// Command detection
// ---------------------------------------------------------------------------

// Common CLI tools whose name at the start of a line strongly signals a
// copyable shell command. Keep sorted for readability.
const CLI_TOOLS = [
  'aws', 'brew', 'bun', 'cargo', 'claude', 'curl', 'docker', 'gh', 'git',
  'go', 'kubectl', 'make', 'node', 'npm', 'npx', 'pip', 'pip3', 'pnpm',
  'python', 'python3', 'ruby', 'scp', 'ssh', 'wget', 'yarn',
]

const CLI_RE = new RegExp(
  `^(?:\\$\\s+)?(?:${CLI_TOOLS.join('|')})\\s+\\S.*$`,
  'gm',
)

/** Shell commands on screen, deduped, first-occurrence order. */
export function extractCommands(text: string): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const m of text.matchAll(CLI_RE)) {
    let cmd = m[0].trim()
    if (cmd.startsWith('$ ')) cmd = cmd.slice(2)
    if (seen.has(cmd)) continue
    seen.add(cmd)
    out.push(cmd)
  }
  return out
}

/** Shorten a command for chip display: keep the first two tokens, ellipsise the rest. */
export function shortenCommand(cmd: string, max = 50): string {
  if (cmd.length <= max) return cmd
  const keep = max - 1
  return `${cmd.slice(0, keep)}…`
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
