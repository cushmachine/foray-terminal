// The terminal's lifecycle, framework-free (compare SocketManager).
//
// One controller per mounted terminal. It owns the attach state machine
// (whether this terminal holds a pty on the server), size reporting, the
// scrollback history (append, cap, the scroll anchor across a reset) and
// the scroll pin that keeps the view at the bottom while output arrives.
// The React side (useTerminal.ts) creates the xterm and the DOM, routes
// events to the methods here and renders overlays from `state`. Anything
// with a clock or a frame in it is injected, so the whole machine runs
// under node with fakes.
//
// Attach states:
//   idle       no pty: the terminal is mounted but not the active one
//   attaching  terminal:attach sent; the server answers with a history
//              reset before it spawns the pty
//   attached   the pty is ours and output flows
//   takenOver  another client attached to the window; the server killed
//              our pty and said so
//   exited     our pty ended on its own (the tmux session died) or the
//              attach failed; the server has already forgotten it
// Only attach() leaves takenOver and exited: the user asks through the
// overlay button, or the terminal becomes the active one again.

import type { ClientMessage, ServerMessage } from '../shared/protocol'
import { MAX_HISTORY_LINES } from '../shared/protocol'
import type { SocketStatus } from '../hooks/useSocket'
import { nextResize, type TerminalDims } from '../terminalSize'
import { ANCHOR_ROWS, findAnchorRow, type RowAnchor } from '../scrollAnchor'

export type AttachState = 'idle' | 'attaching' | 'attached' | 'takenOver' | 'exited'

/** What the controller needs of the xterm. */
export interface TermLike {
  readonly cols: number
  readonly rows: number
  write(data: string, callback?: () => void): void
}

export interface RowLike {
  textContent: string | null
  getBoundingClientRect(): { top: number; bottom: number; height: number }
}

/** The scrollback pane: one rendered row per history line (historyPane.ts). */
export interface HistoryPane {
  readonly rows: ArrayLike<RowLike>
  append(lines: string[]): void
  /** Drop `count` rows from the top. */
  trimTop(count: number): void
  clear(): void
  /**
   * Make the pane exactly `cols` cells wide so it breaks lines where the
   * pty does. Called after every fit: the columns or the font may have changed.
   */
  lockWidth(cols: number): void
}

/** The scroll container holding the history pane and the live screen. */
export interface ScrollLike {
  scrollTop: number
  readonly scrollHeight: number
  readonly clientHeight: number
  scrollTo(options: { top: number; behavior: 'smooth' }): void
  getBoundingClientRect(): { top: number }
}

export interface TerminalControllerOptions {
  term: TermLike
  windowId: number
  send: (msg: ClientMessage) => unknown
  raf?: (cb: () => void) => number
  caf?: (id: number) => void
  /** Fit the xterm to its container; false when the container has no size yet. */
  fit?: () => boolean
  scroll?: ScrollLike
  history?: HistoryPane
  /** The live screen's element, to anchor a view scrolled below the history. */
  screen?: { getBoundingClientRect(): { top: number } }
  /** Pixels to keep below the fold while pinned (composer mode on touch). */
  inset?: () => number
  onStateChange?: (state: AttachState) => void
}

/** How far above the bottom (past the inset) still counts as pinned. */
export const STICK_SLOP_PX = 4

type ScrollAnchor = { kind: 'row'; row: RowAnchor } | { kind: 'screen'; offset: number }

/**
 * A smooth programmatic scroll in flight. The browser animates it over
 * later frames and fires scroll events on the way; those must not unpin
 * the view, but a user scroll in the same moments must. Position tells
 * them apart: the animation only ever moves from `from` towards `to`.
 */
interface ScrollRun {
  from: number
  to: number
  /** The last position seen on the way. */
  last: number
}

export class TerminalController {
  state: AttachState = 'idle'
  /** True once this terminal has held a pty: a lost socket is a reconnect, not a first connect. */
  wasAttached = false
  /** Whether the view is pinned to the bottom, following output. */
  stick = true

  private readonly term: TermLike
  private readonly windowId: number
  private readonly send: (msg: ClientMessage) => unknown
  private readonly raf: (cb: () => void) => number
  private readonly caf: (id: number) => void
  private readonly fit: () => boolean
  private readonly scroll: ScrollLike | null
  private readonly history: HistoryPane | null
  private readonly screen: { getBoundingClientRect(): { top: number } } | null
  private readonly insetSource: () => number
  private readonly onStateChange: ((state: AttachState) => void) | null

  /** Every frame scheduled and not yet run, so dispose() can cancel them all. */
  private readonly frames = new Set<number>()
  private attachFrame: number | null = null
  private fitFrame: number | null = null
  private scrollFrame: number | null = null
  private scrollSmooth = false
  private pinFrame: number | null = null
  private insetFrame: number | null = null
  private reported: TerminalDims | null = null
  private historyCount = 0
  /** The inset as of the last pin, focus change or output; handleScroll reads this. */
  private inset = 0
  private run: ScrollRun | null = null
  private lastStatus: SocketStatus | null = null
  private disposed = false

  constructor(options: TerminalControllerOptions) {
    this.term = options.term
    this.windowId = options.windowId
    this.send = options.send
    this.raf = options.raf ?? ((cb) => requestAnimationFrame(cb))
    this.caf = options.caf ?? ((id) => cancelAnimationFrame(id))
    this.fit = options.fit ?? (() => true)
    this.scroll = options.scroll ?? null
    this.history = options.history ?? null
    this.screen = options.screen ?? null
    this.insetSource = options.inset ?? (() => 0)
    this.onStateChange = options.onStateChange ?? null
  }

  // -- attach state ---------------------------------------------------------

  /** True while the server holds (or is about to hold) a pty for us. */
  private get holdsPty(): boolean {
    return this.state === 'attaching' || this.state === 'attached'
  }

  private setState(state: AttachState): void {
    if (this.state === state) return
    this.state = state
    if (state === 'attached') this.wasAttached = true
    if (!this.disposed) this.onStateChange?.(state)
  }

  /**
   * Ask the server for a pty. One attach per transition: a call while one
   * is in flight, or while attached, does nothing. The attach goes out on
   * the next frame, after a fit, so the pty spawns at the right size and
   * tmux draws once instead of once at 80x24 and again after a resize.
   */
  attach(): void {
    if (this.disposed || this.holdsPty || this.attachFrame !== null) return
    this.attachFrame = this.schedule(() => {
      this.attachFrame = null
      if (this.fit()) this.history?.lockWidth(this.term.cols)
      this.reported = { cols: this.term.cols, rows: this.term.rows }
      // The send fails while the socket is down; onStatus repeats it once
      // the socket is back, which is why the state still moves on.
      this.send({ type: 'terminal:attach', windowId: this.windowId, ...this.reported })
      this.setState('attaching')
    })
  }

  /** Let the pty go (the terminal stopped being the active one). The xterm keeps its screen. */
  detach(): void {
    this.cancel(this.attachFrame)
    this.attachFrame = null
    if (this.holdsPty) this.send({ type: 'terminal:detach', windowId: this.windowId })
    this.setState('idle')
  }

  /** A pty on the old socket died with it: once a new socket is up, ask again. */
  onStatus(status: SocketStatus): void {
    const prev = this.lastStatus
    this.lastStatus = status
    if (status !== 'connected' || prev === 'connected' || !this.holdsPty) return
    this.setState('idle')
    this.attach()
  }

  handle(msg: ServerMessage): void {
    if (!('windowId' in msg) || msg.windowId !== this.windowId) return
    switch (msg.type) {
      case 'terminal:output':
        // A pane on the alternate screen has no scrollback to reset, so
        // its output is the first sign that the pty is ours.
        if (this.state === 'attaching') this.setState('attached')
        this.term.write(msg.data, () => this.maybeScrollToBottom())
        return
      case 'terminal:history':
        if (msg.reset) {
          this.resetHistory(msg.lines)
          if (this.state === 'attaching') this.setState('attached')
        } else {
          this.appendHistory(msg.lines)
        }
        return
      // A notice about a pty we already let go of is stale.
      case 'terminal:detached':
        if (this.holdsPty) this.setState('takenOver')
        return
      case 'terminal:exited':
        if (this.holdsPty) this.setState('exited')
        return
      case 'error':
        if (msg.request === 'terminal:attach' && this.state === 'attaching') this.setState('exited')
        return
    }
  }

  // -- size -------------------------------------------------------------------

  /** Fit on the next frame and report the size if it changed. Coalesced. */
  scheduleFit(): void {
    if (this.disposed || this.fitFrame !== null) return
    this.fitFrame = this.schedule(() => {
      this.fitFrame = null
      this.fitAndReport()
    })
  }

  /**
   * Every resize the server hears becomes a SIGWINCH and a full tmux
   * redraw, so only a size that differs from the last one reported goes
   * out, and only while we hold a pty (the attach carries the size otherwise).
   */
  fitAndReport(): void {
    if (!this.fit()) return
    this.history?.lockWidth(this.term.cols)
    const next = nextResize(this.reported, this.term.cols, this.term.rows)
    if (!next) return
    this.reported = next
    if (this.holdsPty) this.send({ type: 'terminal:resize', windowId: this.windowId, ...next })
    this.maybeScrollToBottom()
  }

  // -- scroll pin -------------------------------------------------------------

  handleScroll(): void {
    const el = this.scroll
    if (!el) return
    const top = el.scrollTop
    const run = this.run
    if (run) {
      const left = Math.abs(top - run.to)
      const closer = left < Math.abs(run.last - run.to) && (top - run.to) * (run.from - run.to) > 0
      if (left > STICK_SLOP_PX && closer) {
        run.last = top
        return
      }
      // Arrived, or moved away: from here on the position is the user's.
      this.run = null
    }
    this.stick = top + el.clientHeight >= el.scrollHeight - this.inset - STICK_SLOP_PX
  }

  /**
   * A wheel, a touch or a key on the scroll container: the browser drops
   * any smooth scroll of ours, so the next scroll event is the user's
   * even when it happens to move the same way.
   */
  onScrollGesture(): void {
    this.run = null
  }

  /** Scroll to the bottom (less the inset) on the next frame. Calls in one frame coalesce; smooth wins. */
  scrollToBottom(smooth = false): void {
    if (!this.scroll || this.disposed) return
    this.scrollSmooth = this.scrollSmooth || smooth
    if (this.scrollFrame !== null) return
    this.scrollFrame = this.schedule(() => {
      this.scrollFrame = null
      const el = this.scroll as ScrollLike
      const wantSmooth = this.scrollSmooth
      this.scrollSmooth = false
      this.inset = this.insetSource()
      const top = Math.max(0, el.scrollHeight - el.clientHeight - this.inset)
      if (wantSmooth) {
        this.run = { from: el.scrollTop, to: top, last: el.scrollTop }
        el.scrollTo({ top, behavior: 'smooth' })
      } else {
        this.run = null
        el.scrollTop = top
      }
    })
  }

  /**
   * The screen changed (output, a resize): a pinned view follows. A
   * scrolled-up one stays, but the inset under the fold may have moved
   * with the screen, and handleScroll reads the cache when the reader
   * comes back down, so it is refreshed either way.
   */
  maybeScrollToBottom(): void {
    if (this.stick) {
      this.scrollToBottom()
      return
    }
    if (this.disposed || this.insetFrame !== null) return
    this.insetFrame = this.schedule(() => {
      this.insetFrame = null
      this.inset = this.insetSource()
    })
  }

  /**
   * Focus moved between the Composer and the terminal, so the pin's target
   * moved: composer mode parks the prompt box below the fold, terminal mode
   * brings it back. Only a pinned view follows. Locking the phone or
   * switching apps blurs and refocuses the input too, and a reader who has
   * scrolled up must stay put.
   */
  onFocusChange(): void {
    this.cancel(this.pinFrame)
    this.pinFrame = this.schedule(() => {
      this.pinFrame = null
      this.inset = this.insetSource()
      if (this.stick) this.scrollToBottom(true)
    })
  }

  // -- history ----------------------------------------------------------------

  private appendHistory(lines: string[]): void {
    if (lines.length === 0 || !this.history) return
    // Rows trimmed from the top move everything below them up; a reader
    // who has scrolled up keeps the same text in view (scrollAnchor.ts).
    const over = this.historyCount + lines.length - MAX_HISTORY_LINES
    const anchor = over > 0 ? this.captureAnchor() : null
    this.history.append(lines)
    this.historyCount += lines.length
    if (over > 0) {
      this.history.trimTop(over)
      this.historyCount -= over
    }
    if (anchor) this.restoreAnchor(anchor)
    this.maybeScrollToBottom()
  }

  /** Replace the history, keeping the same text under a scrolled-up view (scrollAnchor.ts). */
  private resetHistory(lines: string[]): void {
    if (!this.history) return
    const anchor = this.captureAnchor()
    this.history.clear()
    this.historyCount = 0
    this.appendHistory(lines)
    if (anchor) this.restoreAnchor(anchor)
  }

  private contentTop(el: { getBoundingClientRect(): { top: number } }): number {
    const scroll = this.scroll as ScrollLike
    return el.getBoundingClientRect().top - scroll.getBoundingClientRect().top + scroll.scrollTop
  }

  /** A blank row is rendered as one no-break space (historyPane.ts). */
  private static rowText(row: RowLike): string {
    return row.textContent === '\u00a0' ? '' : row.textContent ?? ''
  }

  /** Content-relative scroll position before a history swap. Null when pinned: the bottom follows on its own. */
  private captureAnchor(): ScrollAnchor | null {
    if (this.stick || !this.scroll || !this.history) return null
    const top = this.scroll.scrollTop
    const rows = this.history.rows
    // First history row whose bottom edge is below the viewport top.
    let lo = 0
    let hi = rows.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      const el = rows[mid]
      if (this.contentTop(el) + el.getBoundingClientRect().height > top) hi = mid
      else lo = mid + 1
    }
    if (lo >= rows.length) {
      return this.screen ? { kind: 'screen', offset: top - this.contentTop(this.screen) } : null
    }
    const texts: string[] = []
    for (let i = lo; i < rows.length && texts.length < ANCHOR_ROWS; i++) {
      texts.push(TerminalController.rowText(rows[i]))
    }
    return { kind: 'row', row: { index: lo, texts, offset: top - this.contentTop(rows[lo]) } }
  }

  private restoreAnchor(anchor: ScrollAnchor): void {
    const scroll = this.scroll as ScrollLike
    if (anchor.kind === 'screen') {
      if (this.screen) scroll.scrollTop = this.contentTop(this.screen) + anchor.offset
      return
    }
    const rows = (this.history as HistoryPane).rows
    const texts = Array.from(rows, TerminalController.rowText)
    const i = findAnchorRow(texts, anchor.row)
    // Not found (trimmed away, or the history changed shape): the pixel
    // position stands, which is what happened before anchoring existed.
    if (i < 0) return
    scroll.scrollTop = this.contentTop(rows[i]) + anchor.row.offset
  }

  // -- frames -----------------------------------------------------------------

  private schedule(cb: () => void): number {
    const id = this.raf(() => {
      this.frames.delete(id)
      cb()
    })
    this.frames.add(id)
    return id
  }

  private cancel(id: number | null): void {
    if (id === null) return
    this.caf(id)
    this.frames.delete(id)
  }

  /** Let the pty go and cancel every frame still scheduled. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.detach()
    for (const id of this.frames) this.caf(id)
    this.frames.clear()
    this.fitFrame = this.scrollFrame = this.pinFrame = this.insetFrame = null
  }
}
