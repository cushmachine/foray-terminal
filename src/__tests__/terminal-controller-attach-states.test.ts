// TerminalController attach states: one terminal:attach per transition,
// and no frame outlives the controller.
//
// Run with: npx tsx --test src/__tests__/terminal-controller-attach-states.test.ts

import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ClientMessage } from '../shared/protocol.ts'
import { TerminalController } from '../terminal/TerminalController.ts'

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

test('attach walks idle -> attaching -> attached -> takenOver with one attach per transition', () => {
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

test('dispose cancels every frame the controller scheduled', () => {
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
