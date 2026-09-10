// E2E integration tests for Foray, against this machine's real tmux server.
//
// Run with: npm run test:e2e   (requires tmux; not part of `npm test`)
//
// Each test creates its own nest_e2e-* session and kills it afterwards;
// nothing here touches a session it did not create. Everything that can
// be covered with a fake tmux lives in the unit suites instead.
//
// Covers:
//  1. terminal I/O round-trip through a real pty
//  2. terminal resize leaves the connection working
//  3. the poller notices changes made to tmux behind Foray's back

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, execFile as _execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { startServer } from '../server/index.ts'
import {
  TEST_TOKEN,
  connect,
  waitForMessage,
  waitForOutput,
  waitForType,
  waitForTypeOrError,
} from '../server/__tests__/helpers.ts'

const execFileAsync = promisify(_execFile)

/** Sessions the tests create are named with this prefix, so cleanup can find strays. */
const SESSION_PREFIX = 'nest_e2e-'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function hasTmux(): boolean {
  try {
    execFileSync('tmux', ['-V'], { stdio: 'pipe' })
    return true
  } catch {
    return false
  }
}

/** Safely close a WebSocket, ignoring errors. */
function closeWs(ws: WebSocket): void {
  try {
    ws.close()
  } catch {}
}

/**
 * Kill a Foray session by its numeric tmux session id, ignoring errors.
 * Targets `$id` (a session), never `@id`: window ids are global across
 * tmux, so a window target could hit someone's live session.
 */
function killTmuxSession(sessionId: number): void {
  try {
    execFileSync('tmux', ['kill-session', '-t', `$${sessionId}`], { stdio: 'pipe' })
  } catch {}
}

/** Names of every tmux session on the default server. */
function tmuxSessionNames(): string[] {
  try {
    return execFileSync('tmux', ['list-sessions', '-F', '#{session_name}'], { stdio: 'pipe' })
      .toString()
      .split('\n')
      .filter(Boolean)
  } catch {
    return []
  }
}

// ---------------------------------------------------------------------------
// Environment check
// ---------------------------------------------------------------------------

const TMUX_AVAILABLE = hasTmux()
const tmuxIt = TMUX_AVAILABLE ? test : test.skip

if (!TMUX_AVAILABLE) {
  console.log('[e2e] tmux not found; every test will be skipped')
}

// ---------------------------------------------------------------------------
// Test 1: Terminal I/O round-trip
// ---------------------------------------------------------------------------

tmuxIt('e2e: terminal I/O round-trip', async () => {
  const { url, close } = await startServer(0, { quiet: true, auth: { token: TEST_TOKEN } })
  let windowId: number | null = null
  try {
    const { ws } = await connect(url)
    try {
      const createdPromise = waitForTypeOrError(ws, 'session:created')
      ws.send(JSON.stringify({ type: 'session:create', name: 'e2e-io' }))
      const created = await createdPromise
      windowId = created.window.id as number

      // Start accumulating output BEFORE attaching so nothing is missed.
      const outputPromise = waitForOutput(ws, windowId, 'hello-nest-e2e', 10000)
      ws.send(JSON.stringify({ type: 'terminal:attach', windowId }))

      // Give the pty a moment to start up, then send the echo command
      await new Promise((r) => setTimeout(r, 1000))
      ws.send(JSON.stringify({ type: 'terminal:input', windowId, data: 'echo hello-nest-e2e\r' }))

      const output = await outputPromise
      assert.ok(output.includes('hello-nest-e2e'), 'terminal output should contain the echoed string')
    } finally {
      closeWs(ws)
    }
  } finally {
    if (windowId !== null) killTmuxSession(windowId)
    await close()
  }
})

// ---------------------------------------------------------------------------
// Test 2: Terminal resize
// ---------------------------------------------------------------------------

tmuxIt('e2e: terminal resize does not crash', async () => {
  const { url, close } = await startServer(0, { quiet: true, auth: { token: TEST_TOKEN } })
  let windowId: number | null = null
  try {
    const { ws } = await connect(url)
    try {
      const createdPromise = waitForTypeOrError(ws, 'session:created')
      ws.send(JSON.stringify({ type: 'session:create', name: 'e2e-resize' }))
      const created = await createdPromise
      windowId = created.window.id as number

      ws.send(JSON.stringify({ type: 'terminal:attach', windowId }))
      // Wait for pty to start
      await new Promise((r) => setTimeout(r, 500))

      // Fire-and-forget; only verify the server keeps working afterwards.
      ws.send(JSON.stringify({ type: 'terminal:resize', windowId, cols: 120, rows: 40 }))
      await new Promise((r) => setTimeout(r, 500))

      const pong = waitForType(ws, 'pong')
      ws.send(JSON.stringify({ type: 'ping' }))
      assert.deepEqual(await pong, { type: 'pong' }, 'server should still respond after resize')
    } finally {
      closeWs(ws)
    }
  } finally {
    if (windowId !== null) killTmuxSession(windowId)
    await close()
  }
})

// ---------------------------------------------------------------------------
// Test 3: Live refresh: changes made behind Foray's back reach clients
// ---------------------------------------------------------------------------

tmuxIt('e2e: poller broadcasts session:list when tmux changes outside Foray', async () => {
  const { url, close } = await startServer(0, { pollIntervalMs: 200, quiet: true, auth: { token: TEST_TOKEN } })
  let windowId: number | null = null
  try {
    const { ws } = await connect(url)
    try {
      const createdPromise = waitForTypeOrError(ws, 'session:created')
      ws.send(JSON.stringify({ type: 'session:create', name: 'e2e-poll' }))
      const created = await createdPromise
      windowId = created.window.id as number
      assert.equal(created.window.named, true, 'created with a name => named')
      assert.equal(created.window.title, '', 'a fresh shell carries no title')

      // Rename straight in tmux, no protocol message. The poller should
      // notice and push a fresh list to every client.
      const renamedList = waitForMessage(
        ws,
        (m) =>
          m.type === 'session:list' &&
          m.windows.some((w: any) => w.id === windowId && w.name === 'e2e-poll-moved'),
      )
      await execFileAsync('tmux', ['rename-session', '-t', `$${windowId}`, `${SESSION_PREFIX}poll-moved`])
      await renamedList

      // Put a non-shell command in the foreground and retitle the pane, as
      // a program would via an OSC escape. Title and command should surface
      // together; under a bare shell the title is deliberately blanked.
      const titledList = waitForMessage(
        ws,
        (m) =>
          m.type === 'session:list' &&
          m.windows.some(
            (w: any) => w.id === windowId && w.title === 'e2e title' && w.command === 'sleep',
          ),
      )
      await execFileAsync('tmux', ['send-keys', '-t', `$${windowId}`, 'sleep 30', 'Enter'])
      await execFileAsync('tmux', ['select-pane', '-t', `$${windowId}`, '-T', 'e2e title'])
      const titled = await titledList
      const win = titled.windows.find((w: any) => w.id === windowId)
      assert.equal(win.named, true, 'out-of-band rename keeps the named stamp')
    } finally {
      closeWs(ws)
    }
  } finally {
    if (windowId !== null) killTmuxSession(windowId)
    await close()
  }
})

// ---------------------------------------------------------------------------
// Final cleanup: remove any nest_e2e-* session a failed test left behind
// ---------------------------------------------------------------------------

tmuxIt('e2e: cleanup sessions created by tests', () => {
  for (const name of tmuxSessionNames()) {
    if (!name.startsWith(SESSION_PREFIX)) continue
    try {
      execFileSync('tmux', ['kill-session', '-t', `=${name}`], { stdio: 'pipe' })
      console.log(`[e2e] cleaned up stray session ${name}`)
    } catch {
      // Already gone.
    }
  }
})
