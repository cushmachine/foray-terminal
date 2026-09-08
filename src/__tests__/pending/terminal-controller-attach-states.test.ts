// Pending for S6 (TerminalController extracted from Terminal.tsx).
//
// The attach lifecycle lives in effects and refs spread through
// Terminal.tsx today, so a reconnect, a takeover and a session switch can
// each send their own attach and there is no single place that knows
// whether this terminal holds a pty. Expected: src/terminal/TerminalController.ts
//
//   new TerminalController({ term, windowId, send, raf, caf })
//     term: the xterm-like ({ cols, rows, write, ... }); a fake here
//     send: (msg: ClientMessage) => void
//     raf/caf: requestAnimationFrame/cancelAnimationFrame, injected
//   controller.state: 'idle' | 'attaching' | 'attached' | 'takenOver'
//   controller.attach(): idle/takenOver -> attaching, sends one terminal:attach
//   controller.handle(msg: ServerMessage): terminal:history with reset ->
//     attached; terminal:detached -> takenOver
//   controller.dispose(): cancels every pending frame it scheduled
//
// Skipped until the module exists; the body is written against that API.
//
// Run with: npx tsx --test src/__tests__/pending/terminal-controller-attach-states.test.ts

import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ClientMessage, ServerMessage } from '../../shared/protocol.ts'

type AttachState = 'idle' | 'attaching' | 'attached' | 'takenOver'

interface Controller {
  state: AttachState
  attach(): void
  handle(msg: ServerMessage): void
  dispose(): void
}

interface ControllerOptions {
  term: { cols: number; rows: number; write(data: string): void }
  windowId: number
  send(msg: ClientMessage): void
  raf(cb: () => void): number
  caf(id: number): void
}

const CONTROLLER_MODULE = '../../terminal/TerminalController.ts'

async function loadController(): Promise<new (options: ControllerOptions) => Controller> {
  const mod = (await import(CONTROLLER_MODULE)) as { TerminalController: new (options: ControllerOptions) => Controller }
  return mod.TerminalController
}

/** A frame scheduler the test drives by hand. */
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

test('attach walks idle -> attaching -> attached -> takenOver with one attach per transition', { skip: 'needs S6: src/terminal/TerminalController.ts' }, async () => {
  const TerminalController = await loadController()
  const sent: ClientMessage[] = []
  const frames = fakeFrames()
  const controller = new TerminalController({
    term: { cols: 80, rows: 24, write: () => {} },
    windowId: 7,
    send: (msg) => {
      sent.push(msg)
    },
    raf: frames.raf,
    caf: frames.caf,
  })
  assert.equal(controller.state, 'idle')

  controller.attach()
  frames.flush()
  assert.equal(controller.state, 'attaching')
  assert.deepEqual(sent, [{ type: 'terminal:attach', windowId: 7, cols: 80, rows: 24 }])

  // A second attach while one is in flight sends nothing more.
  controller.attach()
  frames.flush()
  assert.equal(sent.length, 1)

  controller.handle({ type: 'terminal:history', windowId: 7, lines: [], reset: true })
  assert.equal(controller.state, 'attached')

  controller.handle({ type: 'terminal:detached', windowId: 7, reason: 'taken-over' })
  assert.equal(controller.state, 'takenOver')

  // Reattaching after a takeover is one more attach.
  controller.attach()
  frames.flush()
  assert.equal(controller.state, 'attaching')
  assert.equal(sent.length, 2)
  controller.dispose()
})

test('dispose cancels every frame the controller scheduled', { skip: 'needs S6: src/terminal/TerminalController.ts' }, async () => {
  const TerminalController = await loadController()
  const frames = fakeFrames()
  const controller = new TerminalController({
    term: { cols: 80, rows: 24, write: () => {} },
    windowId: 7,
    send: () => {},
    raf: frames.raf,
    caf: frames.caf,
  })
  controller.attach()
  assert.ok(frames.pending.size > 0, 'attach schedules a frame')
  controller.dispose()
  assert.equal(frames.pending.size, 0, 'no frame outlives the controller')
})
