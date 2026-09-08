// Actions the chrome (key toolbar, composer, photo picker) can ask of the
// active terminal without knowing which one that is.
//
// Every mounted Terminal registers its actions under its window id and App
// marks which window is active; a caller asks for `active()` and gets that
// window's actions, or null when no terminal is mounted for it. This
// replaced a set of window CustomEvents that every mounted terminal heard
// and filtered on its own active flag, with untyped payload casts.

export interface TerminalActions {
  /** Send raw bytes as input; the toolbar's sticky modifiers apply. */
  sendKeys(data: string): void
  /** Paste text (bracketed when the program asked for it). */
  paste(text: string): void
  /** Paste text, then press Enter. Empty text is just Enter (the Composer). */
  submit(text: string): void
  /** Upload images and type their paths at the prompt. */
  upload(files: File[]): void
  /** Freeze the screen as selectable text, or return to the live one. */
  toggleSelectMode(): void
}

class TerminalRegistry {
  private readonly terminals = new Map<number, TerminalActions>()
  private activeId: number | null = null

  /** Register a window's actions. Returns the matching unregister. */
  register(windowId: number, actions: TerminalActions): () => void {
    this.terminals.set(windowId, actions)
    return () => {
      if (this.terminals.get(windowId) === actions) this.terminals.delete(windowId)
    }
  }

  setActive(windowId: number | null): void {
    this.activeId = windowId
  }

  /** The active window's actions, or null when none is mounted for it. */
  active(): TerminalActions | null {
    if (this.activeId === null) return null
    return this.terminals.get(this.activeId) ?? null
  }
}

export const terminalRegistry = new TerminalRegistry()
