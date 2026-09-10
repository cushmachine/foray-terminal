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
  /** Freezes the screen as plain text so it can be long-press selected. */
  | 'select'
  /** Opens the photo picker and uploads the result. */
  | 'photo'
  /** Shows or hides the secondary row. */
  | 'more'
  /** Scrolls back to the user's latest prompt line, then earlier ones (promptJump.ts). */
  | 'prompt'

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

/** Fixed at the far left of the bar, only while the scrollback holds a prompt line. */
export const PROMPT_KEY: KeyDef = { id: 'prompt', label: '↑❯', kind: 'prompt', title: 'Back to your last prompt' }

/**
 * Fixed at the far left too, always. Esc is how you stop a model
 * mid-response, so it must never scroll out of reach.
 */
export const ESC_KEY: KeyDef = { id: 'esc', label: 'esc', kind: 'key', data: ESC, title: 'Escape' }

/**
 * The scrolling row, after the pinned keys. The two that act on the screen
 * rather than sending a keystroke lead — select and the photo upload, what
 * a phone reaches for most. The rest follow in terminal order:
 * Tab/Shift-Tab, arrows, Ctrl-C, Enter.
 */
export const PRIMARY_KEYS: KeyDef[] = [
  { id: 'select', label: 'select', kind: 'select', title: 'Select text' },
  { id: 'photo', label: '📷', kind: 'photo', title: 'Upload a photo' },
  { id: 'tab', label: 'tab', kind: 'key', data: '\t', title: 'Tab' },
  { id: 'shift-tab', label: '⇧tab', kind: 'key', data: `${ESC}[Z`, title: 'Shift-Tab' },
  { id: 'ctrl', label: 'ctrl', kind: 'ctrl', title: 'Control (sticky)' },
  { id: 'up', label: '↑', kind: 'key', data: `${ESC}[A`, repeat: true, title: 'Up' },
  { id: 'down', label: '↓', kind: 'key', data: `${ESC}[B`, repeat: true, title: 'Down' },
  { id: 'left', label: '←', kind: 'key', data: `${ESC}[D`, repeat: true, title: 'Left' },
  { id: 'right', label: '→', kind: 'key', data: `${ESC}[C`, repeat: true, title: 'Right' },
  { id: 'ctrl-c', label: '^C', kind: 'key', data: '\x03', title: 'Control-C' },
  { id: 'enter', label: '⏎', kind: 'key', data: '\r', title: 'Enter' },
  { id: 'paste', label: 'paste', kind: 'paste', title: 'Paste from clipboard' },
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

/** Ids in the ⋯ tray, so the toolbar can give that row its own look. */
export const SECONDARY_IDS: ReadonlySet<string> = new Set(SECONDARY_KEYS.map(k => k.id))

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
// Keyboard shortcuts for the chrome: panels, session cycling, and the
// leader key
// ---------------------------------------------------------------------------

export type ShortcutAction =
  | 'toggle-sidebar'
  | 'toggle-files'
  | 'next-session'
  | 'prev-session'
  /** Arm the leader key; the keystroke after it picks a LeaderAction. */
  | 'arm-leader'

/** What the key pressed after the leader does. */
export type LeaderAction = 'new-session' | 'close-session' | 'rename-session' | 'insert-file'

/** The parts of a KeyboardEvent the shortcut table looks at. */
export interface ShortcutKey {
  key: string
  metaKey: boolean
  ctrlKey: boolean
  shiftKey: boolean
  altKey: boolean
}

/**
 * Shifted punctuation back to the key that was actually struck. Browsers
 * report the character shift produces (Shift+. is ">"), but the bindings
 * below are written as a physical key plus a shift flag.
 */
const UNSHIFTED: Record<string, string> = {
  '"': "'",
  '|': '\\',
  '>': '.',
  '<': ',',
}

function baseKey(key: string): string {
  const lower = key.toLowerCase()
  return UNSHIFTED[lower] ?? lower
}

/**
 * Chords with a Command key, which is what a Mac browser leaves to the
 * page. Chrome keeps Cmd+N/T/W for itself and Cmd+, opens its settings, so
 * none of those can appear here. Shift reverses the cycle direction, the
 * way Shift+Tab does.
 */
function metaAction(key: string, shift: boolean): ShortcutAction | null {
  if (key === "'" && !shift) return 'toggle-sidebar'
  if (key === '\\' && !shift) return 'toggle-files'
  if (key === '.') return shift ? 'prev-session' : 'next-session'
  if (key === 'k' && !shift) return 'arm-leader'
  return null
}

/**
 * The same actions for keyboards without a Command key. Shift is spent
 * marking the chord itself, so the two cycle directions need two keys.
 * Plain Ctrl is not available: Ctrl+\ is SIGQUIT and Ctrl+K is kill-line,
 * and the terminal wants both.
 */
function ctrlShiftAction(key: string): ShortcutAction | null {
  if (key === "'") return 'toggle-sidebar'
  if (key === '\\') return 'toggle-files'
  if (key === '.') return 'next-session'
  if (key === ',') return 'prev-session'
  if (key === 'k') return 'arm-leader'
  return null
}

/**
 * Which app-level action a key chord triggers, or null when the key belongs
 * to the terminal. Alt chords are terminal input (the ESC prefix) and plain
 * Ctrl+B is the tmux prefix, so neither is claimed.
 */
export function shortcutAction(e: ShortcutKey): ShortcutAction | null {
  if (e.altKey) return null
  const key = baseKey(e.key)
  if (e.metaKey) return e.ctrlKey ? null : metaAction(key, e.shiftKey)
  if (e.ctrlKey && e.shiftKey) return ctrlShiftAction(key)
  return null
}

/**
 * The action for the key pressed after the leader, or null when that key is
 * not bound. Either way the leader swallows it, the way tmux's prefix does,
 * so a mistyped chord never lands in the terminal as stray input.
 */
export function leaderAction(key: string): LeaderAction | null {
  switch (key.toLowerCase()) {
    case 'n': return 'new-session'
    case 'x': return 'close-session'
    case 'r': return 'rename-session'
    case 'i': return 'insert-file'
    default: return null
  }
}

/**
 * What the leader is waiting for: nothing, the action key, or a second
 * press of "x" to go through with a kill.
 */
export type LeaderMode = null | 'armed' | 'confirm-close'

/** A key that is only a modifier must not spend the armed leader. */
export function isModifierKey(key: string): boolean {
  return key === 'Shift' || key === 'Control' || key === 'Alt' || key === 'Meta'
}

/** How long the leader stays armed waiting for a second key. */
export const LEADER_TIMEOUT_MS = 2000

/**
 * How long to wait before showing the hint. Anyone who already knows the
 * key has pressed it by then and never sees the strip.
 */
export const LEADER_HINT_DELAY_MS = 400

/**
 * How long the kill confirmation stays armed. Longer than the leader's own
 * window: this one has to be read before it is answered.
 */
export const LEADER_CONFIRM_MS = 3000

/** The hint strip, in the order the keys are listed. */
export const LEADER_HINT = 'n new · x close · r rename · i insert'

/** The kill confirmation. Killing a session cannot be undone. */
export function confirmCloseHint(name: string): string {
  return `kill ${name}? x again to confirm · esc to cancel`
}

// ---------------------------------------------------------------------------
// Toolbar overflow hint: edge fades that say the key row scrolls further
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
