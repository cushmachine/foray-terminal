// The registry the chrome reaches the active terminal through, and the one
// piece of timing in it: text queued for a window that has no pty yet.
//
// Run with: npx tsx --test src/__tests__/terminal-registry.test.ts

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { terminalRegistry, type TerminalActions } from '../terminalRegistry.ts'

/** A stand-in terminal that records what was submitted to it. */
function fakeTerminal(): { actions: TerminalActions; submitted: string[] } {
  const submitted: string[] = []
  const noop = (): void => {}
  return {
    submitted,
    actions: {
      sendKeys: noop,
      paste: noop,
      submit: (text: string) => submitted.push(text),
      upload: noop,
      toggleSelectMode: noop,
      jumpToPrompt: noop,
    },
  }
}

test('queued text waits for the pty, then runs exactly once', () => {
  const term = fakeTerminal()
  const unregister = terminalRegistry.register(101, term.actions)
  try {
    terminalRegistry.runWhenAttached(101, 'npm run deploy')
    // Mounted but not attached yet: input now would reach no pty at all.
    assert.deepEqual(term.submitted, [])
    terminalRegistry.setAttached(101, true)
    assert.deepEqual(term.submitted, ['npm run deploy'])
    // Detaching and attaching again is a reconnect, not a reason to rerun it.
    terminalRegistry.setAttached(101, false)
    terminalRegistry.setAttached(101, true)
    assert.deepEqual(term.submitted, ['npm run deploy'])
  } finally {
    terminalRegistry.setAttached(101, false)
    unregister()
  }
})

test('a terminal that already holds its pty runs it straight away', () => {
  const term = fakeTerminal()
  const unregister = terminalRegistry.register(102, term.actions)
  try {
    terminalRegistry.setAttached(102, true)
    terminalRegistry.runWhenAttached(102, 'echo hi')
    assert.deepEqual(term.submitted, ['echo hi'])
  } finally {
    terminalRegistry.setAttached(102, false)
    unregister()
  }
})

test('queued text goes to its own window, and dies with it', () => {
  const kept = fakeTerminal()
  const closed = fakeTerminal()
  const unregisterKept = terminalRegistry.register(103, kept.actions)
  const unregisterClosed = terminalRegistry.register(104, closed.actions)
  try {
    terminalRegistry.runWhenAttached(104, 'npm run deploy')
    terminalRegistry.setAttached(103, true)
    assert.deepEqual(kept.submitted, [])
    // The session went away before it ever attached: nothing is left to run in.
    unregisterClosed()
    const reopened = fakeTerminal()
    const unregisterReopened = terminalRegistry.register(104, reopened.actions)
    terminalRegistry.setAttached(104, true)
    assert.deepEqual(reopened.submitted, [])
    terminalRegistry.setAttached(104, false)
    unregisterReopened()
  } finally {
    terminalRegistry.setAttached(103, false)
    unregisterKept()
  }
})
