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
  /** Scroll back to the user's latest prompt line; again for the one before it. */
  jumpToPrompt(): void
}

class TerminalRegistry {
  private readonly terminals = new Map<number, TerminalActions>()
  /** Per window: whether its scrollback holds a prompt line to jump to. */
  private readonly prompts = new Map<number, boolean>()
  private readonly listeners = new Set<() => void>()
  private activeId: number | null = null

  /** Register a window's actions. Returns the matching unregister. */
  register(windowId: number, actions: TerminalActions): () => void {
    this.terminals.set(windowId, actions)
    return () => {
      if (this.terminals.get(windowId) !== actions) return
      this.terminals.delete(windowId)
      this.prompts.delete(windowId)
      this.notify()
    }
  }

  setActive(windowId: number | null): void {
    if (this.activeId === windowId) return
    this.activeId = windowId
    this.notify()
  }

  /** The active window's actions, or null when none is mounted for it. */
  active(): TerminalActions | null {
    if (this.activeId === null) return null
    return this.terminals.get(this.activeId) ?? null
  }

  setPromptAvailable(windowId: number, available: boolean): void {
    if (this.prompts.get(windowId) === available) return
    this.prompts.set(windowId, available)
    this.notify()
  }

  // Bound, so a React component can hand them to useSyncExternalStore as they are.

  /** Whether the active terminal has a prompt line to jump back to. */
  promptAvailable = (): boolean => this.activeId !== null && (this.prompts.get(this.activeId) ?? false)

  /** Hear about changes to the active window or any window's prompt availability. */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private notify(): void {
    for (const listener of this.listeners) listener()
  }
}

export const terminalRegistry = new TerminalRegistry()
