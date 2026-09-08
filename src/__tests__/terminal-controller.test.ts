// TerminalController: size reporting, the scroll pin, the history cap, the
// detach/attach cycle and what a lost socket does to each state. Driven
// with fake frames, a fake clock and fake DOM-shaped objects.
//
// Run with: npx tsx --test src/__tests__/terminal-controller.test.ts

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MAX_HISTORY_LINES, type ClientMessage } from '../shared/protocol.ts'
import {
  SMOOTH_SCROLL_SETTLE_MS,
  STICK_SLOP_PX,
  TerminalController,
  type AttachState,
  type HistoryPane,
  type RowLike,
  type ScrollLike,
  type TerminalControllerOptions,
} from '../terminal/TerminalController.ts'

const WINDOW = 3

function fakeFrames() {
  const pending = new Map<number, () => void>()
  let nextId = 1
  return {
    raf: (cb: () => void): number => {
      const id = nextId++
      pending.set(id, cb)
      return id
    },
    caf: (id: number): void => {
      pending.delete(id)
    },
    flush(): void {
      const due = [...pending.values()]
      pending.clear()
      for (const cb of due) cb()
    },
    pending,
  }
}

/** A history pane that keeps its rows as strings. */
function fakeHistory() {
  const lines: string[] = []
  const rows: RowLike[] = []
  const pane: HistoryPane & { lines: string[] } = {
    lines,
    get rows() {
      return rows
    },
    append(more) {
      for (const line of more) {
        lines.push(line)
        rows.push({ textContent: line || ' ', getBoundingClientRect: () => ({ top: 0, bottom: 0, height: 0 }) })
      }
    },
    trimTop(count) {
      lines.splice(0, count)
      rows.splice(0, count)
    },
    clear() {
      lines.length = 0
      rows.length = 0
    },
  }
  return pane
}

function fakeScroll(scrollHeight: number, clientHeight: number) {
  const el: ScrollLike & { smoothTo: number | null } = {
    scrollTop: 0,
    scrollHeight,
    clientHeight,
    smoothTo: null,
    scrollTo({ top }) {
      el.smoothTo = top
      el.scrollTop = top
    },
    getBoundingClientRect: () => ({ top: 0 }),
  }
  return el
}

function setup(overrides: Partial<TerminalControllerOptions> = {}) {
  const sent: ClientMessage[] = []
  const frames = fakeFrames()
  const term = { cols: 80, rows: 24, write: (_data: string, cb?: () => void) => cb?.() }
  const states: AttachState[] = []
  let clock = 0
  const controller = new TerminalController({
    term,
    windowId: WINDOW,
    send: (msg) => {
      sent.push(msg)
    },
    raf: frames.raf,
    caf: frames.caf,
    now: () => clock,
    onStateChange: (s) => {
      states.push(s)
    },
    ...overrides,
  })
  const tick = (ms: number) => {
    clock += ms
  }
  /** Attach and answer with the history reset the server sends. */
  const bringUp = () => {
    controller.attach()
    frames.flush()
    controller.handle({ type: 'terminal:history', windowId: WINDOW, lines: [], reset: true })
    assert.equal(controller.state, 'attached')
    sent.length = 0
  }
  return { sent, frames, term, states, controller, tick, bringUp }
}

const types = (sent: ClientMessage[]) => sent.map((m) => m.type)

// -- resize reporting ---------------------------------------------------------

test('resize: a fit that changes the size is reported once; repeats and no-ops are not', () => {
  const { sent, frames, term, controller, bringUp } = setup()
  bringUp()

  controller.scheduleFit()
  controller.scheduleFit() // coalesced into the same frame
  frames.flush()
  assert.deepEqual(sent, [], 'same size as the attach: nothing to report')

  term.cols = 100
  controller.scheduleFit()
  frames.flush()
  assert.deepEqual(sent, [{ type: 'terminal:resize', windowId: WINDOW, cols: 100, rows: 24 }])

  controller.scheduleFit()
  frames.flush()
  assert.equal(sent.length, 1, 'an unchanged size is not repeated')
})

test('resize: not reported while idle (no pty); the next attach carries the size', () => {
  const { sent, frames, term, controller } = setup()
  term.cols = 132
  controller.scheduleFit()
  frames.flush()
  assert.deepEqual(sent, [])

  controller.attach()
  frames.flush()
  assert.deepEqual(sent, [{ type: 'terminal:attach', windowId: WINDOW, cols: 132, rows: 24 }])
})

test('resize: a container with no size is skipped', () => {
  const { sent, frames, term, controller, bringUp } = setup({ fit: () => false })
  bringUp()
  term.cols = 10
  controller.scheduleFit()
  frames.flush()
  assert.deepEqual(sent, [])
})

// -- scroll pin -----------------------------------------------------------------

test('pin: output scrolls a pinned view to the bottom; a scrolled-up view stays', () => {
  const scroll = fakeScroll(1000, 400)
  const { frames, controller, bringUp } = setup({ scroll })
  bringUp()

  controller.handle({ type: 'terminal:output', windowId: WINDOW, data: 'x' })
  controller.handle({ type: 'terminal:output', windowId: WINDOW, data: 'y' })
  assert.equal(frames.pending.size, 1, 'one frame for both writes')
  frames.flush()
  assert.equal(scroll.scrollTop, 600)

  // The user scrolls up to read.
  scroll.scrollTop = 200
  controller.handleScroll()
  assert.equal(controller.stick, false)
  controller.handle({ type: 'terminal:output', windowId: WINDOW, data: 'z' })
  frames.flush()
  assert.equal(scroll.scrollTop, 200, 'output does not pull a reader down')

  // Back within the slop of the bottom: pinned again.
  scroll.scrollTop = 600 - STICK_SLOP_PX
  controller.handleScroll()
  assert.equal(controller.stick, true)
})

test('pin: the inset parks the fold above the bottom, and handleScroll reads the cached inset', () => {
  const scroll = fakeScroll(1000, 400)
  let inset = 0
  const { frames, controller, bringUp } = setup({ scroll, inset: () => inset })
  bringUp()

  inset = 50
  controller.onFocusChange()
  frames.flush() // the pin frame: refreshes the inset, then schedules the smooth scroll
  frames.flush()
  assert.equal(scroll.smoothTo, 550)

  // Sitting at the inset counts as pinned; the cache, not the source, is read.
  inset = 0
  scroll.scrollTop = 550
  controller.handleScroll()
  assert.equal(controller.stick, true)
})

test('pin: scroll events during a smooth scroll do not unpin', () => {
  const scroll = fakeScroll(1000, 400)
  const { frames, controller, tick, bringUp } = setup({ scroll })
  bringUp()

  controller.onFocusChange()
  frames.flush()
  frames.flush()
  assert.equal(scroll.smoothTo, 600)
  // The browser animates: intermediate positions fire scroll events.
  scroll.scrollTop = 100
  controller.handleScroll()
  assert.equal(controller.stick, true, 'ignored while the smooth scroll settles')
  tick(SMOOTH_SCROLL_SETTLE_MS)
  controller.handleScroll()
  assert.equal(controller.stick, false, 'a real position counts once it has settled')
})

test('pin: a focus change while scrolled up leaves the view alone', () => {
  const scroll = fakeScroll(1000, 400)
  const { frames, controller, bringUp } = setup({ scroll })
  bringUp()
  scroll.scrollTop = 100
  controller.handleScroll()
  controller.onFocusChange()
  frames.flush()
  frames.flush()
  assert.equal(scroll.smoothTo, null)
  assert.equal(scroll.scrollTop, 100)
})

// -- history ----------------------------------------------------------------------

test('history: appends accumulate and the oldest rows go once the cap is passed', () => {
  const history = fakeHistory()
  const { controller, bringUp } = setup({ history })
  bringUp()
  const lines = (n: number, from: number) => Array.from({ length: n }, (_, i) => String(from + i))

  controller.handle({ type: 'terminal:history', windowId: WINDOW, lines: lines(MAX_HISTORY_LINES - 10, 0), reset: false })
  assert.equal(history.lines.length, MAX_HISTORY_LINES - 10)
  controller.handle({ type: 'terminal:history', windowId: WINDOW, lines: lines(30, MAX_HISTORY_LINES - 10), reset: false })
  assert.equal(history.lines.length, MAX_HISTORY_LINES)
  assert.equal(history.lines[0], '20', 'the 20 oldest rows were trimmed')
  assert.equal(history.lines[MAX_HISTORY_LINES - 1], String(MAX_HISTORY_LINES + 19))
})

test('history: a reset replaces everything and starts the count over', () => {
  const history = fakeHistory()
  const { controller, bringUp } = setup({ history })
  bringUp()
  controller.handle({ type: 'terminal:history', windowId: WINDOW, lines: ['a', 'b', 'c'], reset: false })
  controller.handle({ type: 'terminal:history', windowId: WINDOW, lines: ['d'], reset: true })
  assert.deepEqual(history.lines, ['d'])
  // The count restarted with the reset: the cap is measured from there.
  const many = Array.from({ length: MAX_HISTORY_LINES }, (_, i) => `r${i}`)
  controller.handle({ type: 'terminal:history', windowId: WINDOW, lines: many, reset: false })
  assert.equal(history.lines.length, MAX_HISTORY_LINES)
  assert.equal(history.lines[0], 'r0')
})

test('history: messages for another window are ignored', () => {
  const history = fakeHistory()
  const { controller, bringUp } = setup({ history })
  bringUp()
  controller.handle({ type: 'terminal:history', windowId: WINDOW + 1, lines: ['x'], reset: false })
  controller.handle({ type: 'terminal:detached', windowId: WINDOW + 1, reason: 'taken-over' })
  assert.deepEqual(history.lines, [])
  assert.equal(controller.state, 'attached')
})

// -- detach / attach cycle ------------------------------------------------------------

test('cycle: leaving the active slot detaches; coming back attaches again', () => {
  const { sent, frames, controller, states, bringUp } = setup()
  bringUp()

  controller.detach()
  assert.equal(controller.state, 'idle')
  assert.deepEqual(sent, [{ type: 'terminal:detach', windowId: WINDOW }])

  controller.detach()
  assert.equal(sent.length, 1, 'a second detach sends nothing')

  controller.attach()
  frames.flush()
  assert.equal(controller.state, 'attaching')
  assert.deepEqual(types(sent), ['terminal:detach', 'terminal:attach'])
  assert.deepEqual(states, ['attaching', 'attached', 'idle', 'attaching'])
})

test('cycle: a detach before the attach frame runs sends neither message', () => {
  const { sent, frames, controller } = setup()
  controller.attach()
  controller.detach()
  frames.flush()
  assert.deepEqual(sent, [])
  assert.equal(controller.state, 'idle')
})

test('cycle: a detach while attaching still tells the server', () => {
  const { sent, frames, controller } = setup()
  controller.attach()
  frames.flush()
  controller.detach()
  assert.deepEqual(types(sent), ['terminal:attach', 'terminal:detach'])
})

test('cycle: takenOver and exited detach silently (the server already dropped the pty)', () => {
  const { sent, frames, controller, bringUp } = setup()
  bringUp()
  controller.handle({ type: 'terminal:detached', windowId: WINDOW, reason: 'taken-over' })
  controller.detach()
  assert.deepEqual(sent, [])
  assert.equal(controller.state, 'idle')

  bringUp()
  controller.handle({ type: 'terminal:exited', windowId: WINDOW })
  assert.equal(controller.state, 'exited')
  controller.attach()
  frames.flush()
  assert.deepEqual(types(sent), ['terminal:attach'], 'the overlay button asks for the pty back')
})

test('cycle: a stale takeover or exit notice while idle changes nothing', () => {
  const { controller, states } = setup()
  controller.handle({ type: 'terminal:detached', windowId: WINDOW, reason: 'taken-over' })
  controller.handle({ type: 'terminal:exited', windowId: WINDOW })
  assert.equal(controller.state, 'idle')
  assert.deepEqual(states, [])
})

test('cycle: a failed attach lands in exited so the user gets a button', () => {
  const { frames, controller } = setup()
  controller.attach()
  frames.flush()
  controller.handle({ type: 'error', message: 'no such window', request: 'terminal:attach', windowId: WINDOW })
  assert.equal(controller.state, 'exited')
})

test('cycle: dispose lets the pty go', () => {
  const { sent, controller, states, bringUp } = setup()
  bringUp()
  controller.dispose()
  assert.deepEqual(sent, [{ type: 'terminal:detach', windowId: WINDOW }])
  assert.deepEqual(states, ['attaching', 'attached'], 'no state callback after dispose')
  controller.attach()
  assert.equal(controller.state, 'idle', 'a disposed controller never attaches again')
})

// -- reconnect --------------------------------------------------------------------------

test('reconnect: a socket that comes back re-attaches an attached terminal, once', () => {
  const { sent, frames, controller, bringUp } = setup()
  controller.onStatus('connected')
  bringUp()
  assert.equal(controller.wasAttached, true)

  controller.onStatus('disconnected')
  controller.onStatus('connecting')
  assert.deepEqual(sent, [], 'nothing to say to a dead socket')
  controller.onStatus('connected')
  frames.flush()
  assert.deepEqual(sent, [{ type: 'terminal:attach', windowId: WINDOW, cols: 80, rows: 24 }])
  assert.equal(controller.state, 'attaching')

  controller.onStatus('connected')
  frames.flush()
  assert.equal(sent.length, 1, 'a repeated connected status is not a reconnect')
})

test('reconnect: an attach that went out while the socket was down is repeated', () => {
  const { sent, frames, controller } = setup({ send: () => false })
  controller.onStatus('connecting')
  controller.attach()
  frames.flush()
  assert.equal(controller.state, 'attaching')
  // The controller hands the message to send() either way; here we watch
  // whether onStatus asks again.
  const again: ClientMessage[] = []
  ;(controller as unknown as { send: (m: ClientMessage) => void }).send = (m) => {
    again.push(m)
  }
  controller.onStatus('connected')
  frames.flush()
  assert.deepEqual(types(again), ['terminal:attach'])
  assert.deepEqual(sent, [])
})

test('reconnect: idle, takenOver and exited terminals do not re-attach', () => {
  const cases: Array<[string, (c: TerminalController, bringUp: () => void) => void]> = [
    ['idle', () => {}],
    ['idle after detach', (c, bringUp) => {
      bringUp()
      c.detach()
    }],
    ['takenOver', (c, bringUp) => {
      bringUp()
      c.handle({ type: 'terminal:detached', windowId: WINDOW, reason: 'taken-over' })
    }],
    ['exited', (c, bringUp) => {
      bringUp()
      c.handle({ type: 'terminal:exited', windowId: WINDOW })
    }],
  ]
  for (const [name, arrange] of cases) {
    const { sent, frames, controller, bringUp } = setup()
    controller.onStatus('connected')
    arrange(controller, bringUp)
    sent.length = 0
    controller.onStatus('disconnected')
    controller.onStatus('connected')
    frames.flush()
    assert.deepEqual(sent, [], `${name} stays put`)
  }
})

test('reconnect: the first connected status on a fresh terminal is not a reconnect', () => {
  const { sent, controller, frames } = setup()
  controller.onStatus('connected')
  frames.flush()
  assert.deepEqual(sent, [])
  assert.equal(controller.wasAttached, false)
})
