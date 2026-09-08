// The palette lives in styles.css, as custom properties on :root. This is
// the read side for the two consumers that need literal values rather
// than var(): xterm paints its theme into a canvas, and the history
// renderer (ansi.ts) writes colours into innerHTML style attributes.
//
// Read at first use, which is at terminal mount: by then the stylesheet
// has loaded (a module script waits for the stylesheets before it) and
// the values are what the rest of the page is already painted with.

import type { ThemeColors } from './ansi'

/** xterm's ITheme, minus the keys Nest leaves at xterm's defaults. */
export interface TerminalTheme extends ThemeColors {
  cursor: string
  cursorAccent: string
  selectionBackground: string
}

const COLOR_VARS: Record<keyof TerminalTheme, string> = {
  background: '--bg',
  foreground: '--text',
  cursor: '--term-cursor',
  cursorAccent: '--bg',
  selectionBackground: '--term-selection',
  black: '--ansi-black',
  red: '--ansi-red',
  green: '--ansi-green',
  yellow: '--ansi-yellow',
  blue: '--ansi-blue',
  magenta: '--ansi-magenta',
  cyan: '--ansi-cyan',
  white: '--ansi-white',
  brightBlack: '--ansi-bright-black',
  brightRed: '--ansi-bright-red',
  brightGreen: '--ansi-bright-green',
  brightYellow: '--ansi-bright-yellow',
  brightBlue: '--ansi-bright-blue',
  brightMagenta: '--ansi-bright-magenta',
  brightCyan: '--ansi-bright-cyan',
  brightWhite: '--ansi-bright-white',
}

function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim()
}

let theme: TerminalTheme | null = null

/** The terminal colours, resolved from the stylesheet once. */
export function terminalTheme(): TerminalTheme {
  if (theme) return theme
  const read = {} as Record<keyof TerminalTheme, string>
  for (const key of Object.keys(COLOR_VARS) as (keyof TerminalTheme)[]) read[key] = cssVar(COLOR_VARS[key])
  theme = read
  return theme
}

/** The monospace stack the page uses, for xterm, which measures it itself. */
export function monoFont(): string {
  return cssVar('--font-mono')
}
