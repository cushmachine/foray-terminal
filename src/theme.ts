// Shared theme constants for Nest.
//
// The terminal, markdown editor, and all UI components share this palette
// and font stack. CSS variables in styles.css define the same values for
// the DOM side; this file is the canonical JS-side source.

/** Full monospace font stack with fallbacks, matching Terminal.tsx's xterm config. */
export const MONO_FONT = "'JetBrains Mono', 'SF Mono', 'Fira Code', 'Cascadia Code', monospace"

/** Terminal color theme — used by xterm.js and the ANSI history renderer. */
export const THEME = {
  background: '#0a0a0c',
  foreground: '#d4d4d8',
  cursor: '#3db8a9',
  cursorAccent: '#0a0a0c',
  selectionBackground: '#3db8a933',
  black: '#1a1a21',
  red: '#d4634f',
  green: '#3db8a9',
  yellow: '#e09a3c',
  blue: '#5e6ad2',
  magenta: '#b07cd8',
  cyan: '#3db8a9',
  white: '#d4d4d8',
  brightBlack: '#636370',
  brightRed: '#e8796a',
  brightGreen: '#5cd4c4',
  brightYellow: '#f0b45c',
  brightBlue: '#8b93e8',
  brightMagenta: '#c99de8',
  brightCyan: '#5cd4c4',
  brightWhite: '#fafafa',
} as const
