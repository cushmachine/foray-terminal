// The key toolbar's vocabulary, as data.
//
// Everything a phone keyboard can't type but a terminal needs: escape,
// tab, arrows, control chords, and the symbols that hide behind a shift
// layer on iOS. Kept free of React and the DOM so the byte sequences can
// be unit tested; KeyToolbar.tsx renders these and Terminal.tsx applies
// the sticky modifiers.

export type KeyKind =
  /** Sends `data` as terminal input. */
  | 'key'
  /** Toggles a sticky modifier that applies to the next key or typed character. */
  | 'ctrl'
  | 'alt'
  /** Reads the clipboard and pastes it into the terminal. */
  | 'paste'
  /** Copies the visible terminal screen to the clipboard. */
  | 'copy-screen'
  /** Opens the photo picker and uploads the result. */
  | 'photo'
  /** Shows or hides the secondary row. */
  | 'more'

export interface KeyDef {
  id: string
  label: string
  kind: KeyKind
  /** Bytes to send for `kind: 'key'`. */
  data?: string
  /** Holding the key repeats it (arrows, backspace). */
  repeat?: boolean
  /** Spoken label for screen readers when the visible one is a glyph. */
  title?: string
}

const ESC = '\x1b'

/** Always visible. Ordered for Claude Code: Esc, Tab/Shift-Tab, arrows, Ctrl-C, Enter. */
export const PRIMARY_KEYS: KeyDef[] = [
  { id: 'esc', label: 'esc', kind: 'key', data: ESC, title: 'Escape' },
  { id: 'tab', label: 'tab', kind: 'key', data: '\t', title: 'Tab' },
  { id: 'shift-tab', label: '⇧tab', kind: 'key', data: `${ESC}[Z`, title: 'Shift-Tab' },
  { id: 'ctrl', label: 'ctrl', kind: 'ctrl', title: 'Control (sticky)' },
  { id: 'up', label: '↑', kind: 'key', data: `${ESC}[A`, repeat: true, title: 'Up' },
  { id: 'down', label: '↓', kind: 'key', data: `${ESC}[B`, repeat: true, title: 'Down' },
  { id: 'left', label: '←', kind: 'key', data: `${ESC}[D`, repeat: true, title: 'Left' },
  { id: 'right', label: '→', kind: 'key', data: `${ESC}[C`, repeat: true, title: 'Right' },
  { id: 'ctrl-c', label: '^C', kind: 'key', data: '\x03', title: 'Control-C' },
  { id: 'enter', label: '⏎', kind: 'key', data: '\r', title: 'Enter' },
  { id: 'copy-screen', label: 'copy', kind: 'copy-screen', title: 'Copy terminal screen' },
  { id: 'paste', label: 'paste', kind: 'paste', title: 'Paste from clipboard' },
  { id: 'photo', label: '📷', kind: 'photo', title: 'Upload a photo' },
  { id: 'more', label: '⋯', kind: 'more', title: 'More keys' },
]

/** Shown when "more" is toggled on. */
export const SECONDARY_KEYS: KeyDef[] = [
  { id: 'alt', label: 'alt', kind: 'alt', title: 'Alt (sticky)' },
  { id: 'home', label: 'home', kind: 'key', data: `${ESC}[H`, title: 'Home' },
  { id: 'end', label: 'end', kind: 'key', data: `${ESC}[F`, title: 'End' },
  { id: 'pgup', label: 'pgup', kind: 'key', data: `${ESC}[5~`, title: 'Page Up' },
  { id: 'pgdn', label: 'pgdn', kind: 'key', data: `${ESC}[6~`, title: 'Page Down' },
  { id: 'backspace', label: '⌫', kind: 'key', data: '\x7f', repeat: true, title: 'Backspace' },
  { id: 'ctrl-d', label: '^D', kind: 'key', data: '\x04', title: 'Control-D' },
  { id: 'ctrl-z', label: '^Z', kind: 'key', data: '\x1a', title: 'Control-Z' },
  { id: 'ctrl-r', label: '^R', kind: 'key', data: '\x12', title: 'Control-R' },
  { id: 'ctrl-l', label: '^L', kind: 'key', data: '\x0c', title: 'Control-L' },
  { id: 'ctrl-u', label: '^U', kind: 'key', data: '\x15', title: 'Control-U' },
  { id: 'slash', label: '/', kind: 'key', data: '/' },
  { id: 'dash', label: '-', kind: 'key', data: '-' },
  { id: 'pipe', label: '|', kind: 'key', data: '|' },
  { id: 'tilde', label: '~', kind: 'key', data: '~' },
  { id: 'backslash', label: '\\', kind: 'key', data: '\\' },
  { id: 'underscore', label: '_', kind: 'key', data: '_' },
]

export interface Modifiers {
  ctrl: boolean
  alt: boolean
}

export const NO_MODIFIERS: Modifiers = { ctrl: false, alt: false }

/**
 * Control-key mapping for the punctuation that has one. Letters are handled
 * arithmetically (Ctrl-A is 0x01 ... Ctrl-Z is 0x1a).
 */
const CTRL_PUNCTUATION: Record<string, string> = {
  '@': '\x00',
  ' ': '\x00',
  '[': '\x1b',
  '\\': '\x1c',
  ']': '\x1d',
  '^': '\x1e',
  '_': '\x1f',
  '?': '\x7f',
}

/**
 * Apply sticky modifiers to a chunk of input. Ctrl only makes sense for a
 * single character (a letter or one of the punctuation marks above);
 * anything else passes through unchanged. Alt is the ESC prefix, which is
 * how terminals have encoded it since before there were phones.
 */
export function applyModifiers(data: string, mods: Modifiers): string {
  let out = data
  if (mods.ctrl && data.length === 1) {
    const ch = data
    if (/[a-zA-Z]/.test(ch)) {
      out = String.fromCharCode(ch.toUpperCase().charCodeAt(0) - 64)
    } else if (ch in CTRL_PUNCTUATION) {
      out = CTRL_PUNCTUATION[ch]
    }
  }
  if (mods.alt) out = ESC + out
  return out
}

/** Hold-to-repeat timing: wait, then fire on an interval. */
export const REPEAT_INITIAL_MS = 400
export const REPEAT_INTERVAL_MS = 60

/**
 * Delay before the nth repeat fires (n = 0 is the first repeat after the
 * initial hold). Pure so the schedule can be tested without timers.
 */
export function repeatDelay(n: number): number {
  return n === 0 ? REPEAT_INITIAL_MS : REPEAT_INTERVAL_MS
}

/** Pointer travel beyond which a press is a scroll, not a tap. */
export const TAP_SLOP_PX = 10

// ---------------------------------------------------------------------------
// Keyboard shortcuts for the chrome (AUDIT #9)
// ---------------------------------------------------------------------------

export type ShortcutAction = 'toggle-sidebar' | 'toggle-files'

/** The parts of a KeyboardEvent the shortcut table looks at. */
export interface ShortcutKey {
  key: string
  metaKey: boolean
  ctrlKey: boolean
  shiftKey: boolean
  altKey: boolean
}

/**
 * Which app-level action a key chord triggers, or null when the key belongs
 * to the terminal. Meta+B / Meta+\ follow VS Code; Ctrl+Shift+B / Ctrl+Shift+\
 * cover keyboards without a Command key. Plain Ctrl+B is the tmux prefix and
 * Alt chords are terminal input, so neither is claimed.
 */
export function shortcutAction(e: ShortcutKey): ShortcutAction | null {
  if (e.altKey) return null
  const chord = e.metaKey ? !e.ctrlKey : e.ctrlKey && e.shiftKey
  if (!chord) return null
  const key = e.key.toLowerCase()
  if (key === 'b') return 'toggle-sidebar'
  // Shift+\ types | on most layouts, so accept both spellings.
  if (key === '\\' || key === '|') return 'toggle-files'
  return null
}

// ---------------------------------------------------------------------------
// Toolbar overflow hint (AUDIT #5)
// ---------------------------------------------------------------------------

export interface ScrollMetrics {
  scrollLeft: number
  clientWidth: number
  scrollWidth: number
}

/**
 * Which edges of a horizontally scrolling row still have content past
 * them. A one-pixel tolerance keeps sub-pixel scroll positions from
 * flickering the hint at the ends.
 */
export function overflowHint({ scrollLeft, clientWidth, scrollWidth }: ScrollMetrics): { left: boolean; right: boolean } {
  return {
    left: scrollLeft > 1,
    right: scrollWidth - (scrollLeft + clientWidth) > 1,
  }
}
