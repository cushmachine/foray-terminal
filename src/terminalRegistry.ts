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
  /** Windows whose terminal holds a pty on the server right now. */
  private readonly attached = new Set<number>()
  /** Per window: text waiting for that pty to exist (see runWhenAttached). */
  private readonly pending = new Map<number, string>()
  private readonly listeners = new Set<() => void>()
  private activeId: number | null = null

  /** Register a window's actions. Returns the matching unregister. */
  register(windowId: number, actions: TerminalActions): () => void {
    this.terminals.set(windowId, actions)
    // A remount of a window that still holds its pty can arrive after the
    // work was queued; either order releases it.
    this.flush(windowId)
    return () => {
      if (this.terminals.get(windowId) !== actions) return
      this.terminals.delete(windowId)
      this.prompts.delete(windowId)
      this.attached.delete(windowId)
      // The terminal is gone, so nothing queued for it can ever run.
      this.pending.delete(windowId)
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

  /**
   * Whether a window's terminal holds a pty, reported by the terminal as
   * its attach state changes. No notify(): nothing on screen renders from
   * this, it only releases work queued below.
   */
  setAttached(windowId: number, attached: boolean): void {
    if (attached === this.attached.has(windowId)) return
    if (attached) {
      this.attached.add(windowId)
      this.flush(windowId)
    } else {
      this.attached.delete(windowId)
    }
  }

  /**
   * Submit `text` in a window as soon as its terminal holds a pty, or now
   * if it already does. Input for a window this connection has not
   * finished attaching to reaches a pty that does not exist yet and is
   * dropped on the floor, so a command sent the moment a session is
   * created — "sync now" and its deploy — has to wait for the attach that
   * follows. One queued text per window; the newest replaces it.
   */
  runWhenAttached(windowId: number, text: string): void {
    this.pending.set(windowId, text)
    this.flush(windowId)
  }

  private flush(windowId: number): void {
    const text = this.pending.get(windowId)
    const actions = this.terminals.get(windowId)
    if (text === undefined || !actions || !this.attached.has(windowId)) return
    this.pending.delete(windowId)
    actions.submit(text)
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
