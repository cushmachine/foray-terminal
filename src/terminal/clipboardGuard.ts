// Whether a program may set the clipboard through the terminal (OSC 52).
// Pure, no DOM, so it runs under node tests; useTerminal.ts wires it to
// the clipboard addon.

/**
 * How soon after the user's last keystroke a program may set the
 * clipboard through OSC 52. A yank in vim or a copy in tmux follows a key
 * at once; a file an agent is reading, with a sequence planted in it,
 * arrives while the user's hands are off the keys.
 */
export const CLIPBOARD_WRITE_WINDOW_MS = 5_000

/** Longest clipboard text a program may set; a command, not a document. */
export const CLIPBOARD_WRITE_MAX_CHARS = 64 * 1024

/**
 * Whether a program's clipboard write is allowed: it must follow the
 * user's own input closely, and be of a size a person would copy. Pure,
 * for the tests.
 */
export function clipboardWriteAllowed(lastInputAt: number, now: number, text: string): boolean {
  return lastInputAt > 0 && now - lastInputAt <= CLIPBOARD_WRITE_WINDOW_MS && text.length <= CLIPBOARD_WRITE_MAX_CHARS
}
