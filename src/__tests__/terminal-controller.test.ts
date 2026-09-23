// TerminalController: size reporting, the scroll pin, the history cap, the
// detach/attach cycle and what a lost socket does to each state. Driven
// with fake frames and fake DOM-shaped objects.
//
// Run with: npx tsx --test src/__tests__/terminal-controller.test.ts

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MAX_HISTORY_LINES, type ClientMessage } from '../shared/protocol.ts'
import { PROMPT_JUMP_MARGIN_PX } from '../promptJump.ts'
import {
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

/**
 * A history pane that keeps its rows as strings. With a row height and the
 * scroll element it also lays the rows out, `rowHeight` pixels each from
 * the top of the content, so the anchor code can measure them.
 */
function fakeHistory(rowHeight = 0, scroll?: ScrollLike) {
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
        const row: RowLike = {
          textContent: line || ' ',
          getBoundingClientRect() {
            const top = rows.indexOf(row) * rowHeight - (scroll?.scrollTop ?? 0)
            return { top, bottom: top + rowHeight, height: rowHeight }
          },
        }
        rows.push(row)
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
    lockWidth() {},
  }
  return pane
}

/**
 * A scroll container. A smooth scrollTo only records its target: the
 * browser animates over later frames, and a test plays those positions
 * back through handleScroll itself.
 */
function fakeScroll(scrollHeight: number, clientHeight: number) {
  const el: ScrollLike & { smoothTo: number | null } = {
    scrollTop: 0,
    scrollHeight,
    clientHeight,
    smoothTo: null,
    scrollTo({ top }) {
      el.smoothTo = top
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
  const controller = new TerminalController({
    term,
    windowId: WINDOW,
    send: (msg) => {
      sent.push(msg)
    },
    raf: frames.raf,
    caf: frames.caf,
    onStateChange: (s) => {
      states.push(s)
    },
    ...overrides,
  })
  /** Attach and answer with the history reset the server sends. */
  const bringUp = () => {
    controller.attach()
    frames.flush()
    controller.handle({ type: 'terminal:history', windowId: WINDOW, lines: [], reset: true })
    assert.equal(controller.state, 'attached')
    sent.length = 0
  }
  return { sent, frames, term, states, controller, bringUp }
}

const types = (sent: ClientMessage[]) => sent.map((m) => m.type)
const output = (data: string) => ({ type: 'terminal:output', windowId: WINDOW, data }) as const

/** The browser moved the scroll container to `top` and fired a scroll event. */
function scrolled(controller: TerminalController, el: ScrollLike, top: number): void {
  el.scrollTop = top
  controller.handleScroll()
}

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

test('pin: a smooth scroll on its way to the target does not unpin; a scroll away from it does', () => {
  const scroll = fakeScroll(1000, 400)
  let inset = 0
  const { frames, controller, bringUp } = setup({ scroll, inset: () => inset })
  bringUp()
  scroll.scrollTop = 600

  // The composer takes focus: the pin moves up by the inset, smoothly.
  inset = 100
  controller.onFocusChange()
  frames.flush()
  frames.flush()
  assert.equal(scroll.smoothTo, 500)
  // The browser animates: intermediate positions fire scroll events.
  scrolled(controller, scroll, 570)
  scrolled(controller, scroll, 530)
  assert.equal(controller.stick, true, 'on its way to the target')
  scrolled(controller, scroll, 500)
  assert.equal(controller.stick, true, 'arrived')

  // A second focus change starts another one; the user grabs the view
  // mid-flight and scrolls up. That is not the animation any more.
  inset = 0
  controller.onFocusChange()
  frames.flush()
  frames.flush()
  assert.equal(scroll.smoothTo, 600)
  scrolled(controller, scroll, 540)
  assert.equal(controller.stick, true)
  scrolled(controller, scroll, 300)
  assert.equal(controller.stick, false, 'moving away from the target is the user')
  scrolled(controller, scroll, 400)
  assert.equal(controller.stick, false, 'and the animation does not get its claim back')
})

test('pin: a wheel, touch or key hands the next scroll event to the user', () => {
  const scroll = fakeScroll(1000, 400)
  let inset = 100
  const { frames, controller, bringUp } = setup({ scroll, inset: () => inset })
  bringUp()
  controller.onFocusChange()
  frames.flush()
  frames.flush()
  scrolled(controller, scroll, 500)
  assert.equal(controller.stick, true)

  // Composer blurred: the view glides down from the inset to the bottom.
  inset = 0
  controller.onFocusChange()
  frames.flush()
  frames.flush()
  assert.equal(scroll.smoothTo, 600)
  scrolled(controller, scroll, 520)
  assert.equal(controller.stick, true)
  // A wheel nudge: whatever the container does next is the user's doing,
  // even a small move in the animation's own direction.
  controller.onScrollGesture()
  scrolled(controller, scroll, 540)
  assert.equal(controller.stick, false)
})

// The keyboard.spec reconnect flake: with a time window instead of a target,
// a user scroll within 600 ms of a focus change was swallowed, the view
// stayed "pinned", and the next history reset dragged it to the bottom.
test('pin: a user scroll right after a focus change unpins, so a history reset leaves the view where it is', () => {
  const scroll = fakeScroll(1000, 400)
  const history = fakeHistory()
  const { frames, controller, bringUp } = setup({ scroll, history })
  bringUp()
  scroll.scrollTop = 600
  controller.onFocusChange()
  frames.flush()
  frames.flush()
  assert.equal(scroll.smoothTo, 600)

  // Straight away, the user scrolls up to read.
  scrolled(controller, scroll, 200)
  assert.equal(controller.stick, false)

  // The socket came back: the server replaces the scrollback.
  controller.handle({ type: 'terminal:history', windowId: WINDOW, lines: ['a', 'b'], reset: true })
  frames.flush()
  assert.equal(scroll.scrollTop, 200, 'the reader keeps their place')
})

test('pin: output while scrolled up refreshes the inset, so the pin check is right when the reader comes back down', () => {
  const scroll = fakeScroll(1000, 400)
  let inset = 50
  const { frames, controller, bringUp } = setup({ scroll, inset: () => inset })
  bringUp()
  controller.onFocusChange()
  frames.flush()
  frames.flush()
  assert.equal(scroll.smoothTo, 550)
  scrolled(controller, scroll, 550)
  assert.equal(controller.stick, true)

  scrolled(controller, scroll, 200)
  assert.equal(controller.stick, false)
  // The screen redraws under the fold: more chrome below the last output row.
  inset = 150
  controller.handle(output('x'))
  frames.flush()
  assert.equal(scroll.scrollTop, 200, 'a scrolled-up view is not moved')

  // Back down to where the fold now is.
  scrolled(controller, scroll, 450)
  assert.equal(controller.stick, true)
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

/** display:none on the scroll container, then back: the browser zeroes scrollTop and may fire a scroll event on the way. */
function hideAndShow(controller: TerminalController, el: ScrollLike & { clientHeight: number }, height: number): void {
  el.clientHeight = 0
  el.scrollTop = 0
  controller.onScrollResize()
  controller.handleScroll()
  el.clientHeight = height
  controller.handleScroll()
  controller.onScrollResize()
}

test('hide: a pinned tab shown again goes back to the bottom, even after a scroll event at the top', () => {
  const scroll = fakeScroll(1000, 400) as ReturnType<typeof fakeScroll> & { clientHeight: number }
  const { frames, controller, bringUp } = setup({ scroll })
  bringUp()
  controller.handle(output('x'))
  frames.flush()
  assert.equal(scroll.scrollTop, 600)

  hideAndShow(controller, scroll, 400)
  assert.equal(controller.stick, true, 'the scroll events around the hide did not unpin')
  frames.flush()
  assert.equal(scroll.scrollTop, 600)
})

test('hide: a scrolled-up tab shown again keeps its place', () => {
  const scroll = fakeScroll(1000, 400) as ReturnType<typeof fakeScroll> & { clientHeight: number }
  const { frames, controller, bringUp } = setup({ scroll })
  bringUp()
  scrolled(controller, scroll, 250)

  hideAndShow(controller, scroll, 400)
  frames.flush()
  assert.equal(controller.stick, false)
  assert.equal(scroll.scrollTop, 250)
})

test('hide: a history reset while hidden does not anchor to zeroed rects', () => {
  const scroll = fakeScroll(1000, 400) as ReturnType<typeof fakeScroll> & { clientHeight: number }
  const history = fakeHistory(20, scroll)
  const { frames, controller, bringUp } = setup({ scroll, history })
  bringUp()
  controller.handle({ type: 'terminal:history', windowId: WINDOW, lines: Array.from({ length: 50 }, (_, i) => `l${i}`), reset: true })
  frames.flush()
  scrolled(controller, scroll, 300)

  scroll.clientHeight = 0
  scroll.scrollTop = 0
  controller.onScrollResize()
  controller.handle({ type: 'terminal:history', windowId: WINDOW, lines: Array.from({ length: 50 }, (_, i) => `l${i}`), reset: true })
  scroll.clientHeight = 400
  controller.onScrollResize()
  frames.flush()
  assert.equal(scroll.scrollTop, 300)
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

test('history: trimming the top under a scrolled-up view keeps the same text at the top of the viewport', () => {
  const scroll = fakeScroll(MAX_HISTORY_LINES * 10 + 400, 400)
  const history = fakeHistory(10, scroll)
  const { frames, controller, bringUp } = setup({ scroll, history })
  bringUp()
  const lines = (n: number, from: number) => Array.from({ length: n }, (_, i) => String(from + i))
  controller.handle({ type: 'terminal:history', windowId: WINDOW, lines: lines(MAX_HISTORY_LINES, 0), reset: false })
  frames.flush()

  // Reading row 1000 at the top of the viewport.
  scrolled(controller, scroll, 10_000)
  assert.equal(controller.stick, false)
  controller.handle({ type: 'terminal:history', windowId: WINDOW, lines: lines(100, MAX_HISTORY_LINES), reset: false })
  frames.flush()
  assert.equal(history.lines[0], '100', 'the 100 oldest rows went')
  assert.equal(history.lines[900], '1000')
  assert.equal(scroll.scrollTop, 9_000, 'row 1000 is still at the top of the viewport')
})

// -- prompt jump ----------------------------------------------------------------

const filler = (n: number, tag = 'line') => Array.from({ length: n }, (_, i) => `${tag} ${i}`)
const historyMsg = (lines: string[], reset = false) => ({ type: 'terminal:history', windowId: WINDOW, lines, reset }) as const

test('prompt jump: the latest prompt line comes to the top of the viewport, then each earlier one, wrapping', () => {
  const scroll = fakeScroll(200 * 10 + 400, 400)
  const history = fakeHistory(10, scroll)
  const { frames, controller, bringUp } = setup({ scroll, history })
  bringUp()
  // '❯ first ask' is row 51, '❯ second ask' row 132.
  controller.handle(historyMsg(['$ start', ...filler(50), '❯ first ask', ...filler(80), '❯ second ask', ...filler(60)]))
  frames.flush()
  assert.equal(controller.promptAvailable, true)
  assert.equal(controller.stick, true, 'pinned at the bottom before the jump')

  assert.equal(controller.jumpToPrompt(), true)
  assert.equal(scroll.scrollTop, 132 * 10 - PROMPT_JUMP_MARGIN_PX)
  assert.equal(controller.stick, false, 'the view is the reader\'s now')
  frames.flush()
  assert.equal(scroll.scrollTop, 132 * 10 - PROMPT_JUMP_MARGIN_PX, 'no pending pin undid it')

  controller.jumpToPrompt()
  assert.equal(scroll.scrollTop, 51 * 10 - PROMPT_JUMP_MARGIN_PX, 'the one before')
  controller.jumpToPrompt()
  assert.equal(scroll.scrollTop, 132 * 10 - PROMPT_JUMP_MARGIN_PX, 'past the first: back to the latest')

  // A scroll gesture starts over at the latest.
  controller.jumpToPrompt()
  assert.equal(scroll.scrollTop, 51 * 10 - PROMPT_JUMP_MARGIN_PX)
  controller.onScrollGesture()
  controller.jumpToPrompt()
  assert.equal(scroll.scrollTop, 132 * 10 - PROMPT_JUMP_MARGIN_PX)
})

test('prompt jump: nothing to jump to without a prompt line; the empty input box does not count', () => {
  const scroll = fakeScroll(400, 400)
  const history = fakeHistory(10, scroll)
  const { frames, controller, bringUp } = setup({ scroll, history })
  bringUp()
  controller.handle(historyMsg(['hello', '❯', '❯ ', 'more']))
  frames.flush()
  assert.equal(controller.promptAvailable, false)
  const before = scroll.scrollTop
  assert.equal(controller.jumpToPrompt(), false)
  assert.equal(scroll.scrollTop, before)
})

test('prompt jump: a prompt still on the live screen is reachable, after the scrollback rows', () => {
  const scroll = fakeScroll(10 * 10 + 400, 400)
  const history = fakeHistory(10, scroll)
  const screenLines = () => ({ texts: ['reply', '❯ on screen', 'more reply'], rowTop: (i: number) => 1000 + i * 10 })
  const { frames, controller, bringUp } = setup({ scroll, history, screenLines })
  bringUp()
  controller.handle(historyMsg(['❯ old ask', ...filler(9)]))
  frames.flush()

  controller.jumpToPrompt()
  assert.equal(scroll.scrollTop, 1010 - PROMPT_JUMP_MARGIN_PX, 'the screen row, measured where the screen sits')
  controller.jumpToPrompt()
  assert.equal(scroll.scrollTop, 0, 'row 0 of the scrollback, clamped at the top')
})

test('prompt jump: availability follows the scrollback through resets and trims', () => {
  const scroll = fakeScroll(MAX_HISTORY_LINES * 10 + 400, 400)
  const history = fakeHistory(10, scroll)
  const seen: boolean[] = []
  const { frames, controller, bringUp } = setup({ scroll, history, onPromptAvailable: (v) => seen.push(v) })
  bringUp()
  assert.equal(controller.promptAvailable, false)

  controller.handle(historyMsg(['❯ only ask', ...filler(MAX_HISTORY_LINES - 1)]))
  frames.flush()
  assert.equal(controller.promptAvailable, true)

  // The cap pushes the only prompt off the top.
  controller.handle(historyMsg(filler(5, 'later')))
  frames.flush()
  assert.equal(history.lines[0], 'line 4')
  assert.equal(controller.promptAvailable, false)

  controller.handle(historyMsg(['❯ again'], true))
  frames.flush()
  assert.equal(controller.promptAvailable, true)
  controller.handle(historyMsg(['plain'], true))
  frames.flush()
  assert.equal(controller.promptAvailable, false)
  assert.deepEqual(seen, [true, false, true, false])
})

test('prompt jump: a trim under the reader keeps the step order by shifting the cursor', () => {
  const scroll = fakeScroll(MAX_HISTORY_LINES * 10 + 400, 400)
  const history = fakeHistory(10, scroll)
  const { frames, controller, bringUp } = setup({ scroll, history })
  bringUp()
  const lines = filler(MAX_HISTORY_LINES)
  lines[1000] = '❯ a'
  lines[2000] = '❯ b'
  lines[2500] = '❯ c'
  controller.handle(historyMsg(lines))
  frames.flush()
  controller.jumpToPrompt() // c
  controller.jumpToPrompt() // b
  assert.equal(scroll.scrollTop, 2000 * 10 - PROMPT_JUMP_MARGIN_PX)
  // 100 rows fall off the top; b is now row 1900 and the next step must still be a, not b again.
  controller.handle(historyMsg(filler(100, 'new')))
  frames.flush()
  controller.jumpToPrompt()
  assert.equal(scroll.scrollTop, 900 * 10 - PROMPT_JUMP_MARGIN_PX)
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

// A pane on the alternate screen (vim, Claude Code) has no scrollback to
// reset, so the first sign of the pty is its output.
test('cycle: output while attaching means the pty is ours', () => {
  const { frames, controller, states } = setup()
  controller.attach()
  frames.flush()
  controller.handle(output('\x1b[?1049h'))
  assert.equal(controller.state, 'attached')
  controller.handle({ type: 'terminal:history', windowId: WINDOW, lines: [], reset: true })
  assert.deepEqual(states, ['attaching', 'attached'])
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
