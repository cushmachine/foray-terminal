// E2E integration tests for Nest.
//
// Run with: npm run test:e2e
// (executed directly via `tsx`, using node's built-in test runner)
//
// These tests start a real server, connect real WebSocket clients, and
// exercise the full stack through the WebSocket protocol. tmux-dependent
// tests are skipped when tmux is not available.
//
// Tests 1-5 and 9 require tmux.
// Tests 6-8 and 10 exercise the filesystem API and work everywhere.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { execFileSync, execFile as _execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { startServer } from '../server/index.ts'

const execFileAsync = promisify(_execFile)

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Check if tmux is installed and available. */
function hasTmux(): boolean {
  try {
    execFileSync('tmux', ['-V'], { stdio: 'pipe' })
    return true
  } catch {
    return false
  }
}

/** Check if the "nest" tmux session already exists. */
function nestSessionExists(): boolean {
  try {
    execFileSync('tmux', ['has-session', '-t', 'nest'], { stdio: 'pipe' })
    return true
  } catch {
    return false
  }
}

/**
 * Connect a WebSocket and wait for the welcome `session:list` message.
 * Returns both the socket and the parsed welcome payload.
 */
async function connectAndWaitForWelcome(url: string): Promise<{ ws: WebSocket; welcome: any }> {
  const wsUrl = url.replace(/^http/, 'ws') + '/ws'
  const ws = new WebSocket(wsUrl)
  const welcome = await new Promise<any>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('timed out waiting for welcome')), 5000)
    ws.addEventListener(
      'message',
      (event) => {
        clearTimeout(timeout)
        resolve(JSON.parse((event as MessageEvent).data.toString()))
      },
      { once: true },
    )
    ws.addEventListener('error', reject)
  })
  return { ws, welcome }
}

/**
 * Wait for a WebSocket message matching a predicate.
 * Resolves with the parsed message. Rejects on timeout.
 */
function waitForMessage(
  ws: WebSocket,
  predicate: (msg: any) => boolean,
  timeoutMs = 5000,
): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.removeEventListener('message', handler)
      reject(new Error('Timeout waiting for message'))
    }, timeoutMs)
    const handler = (event: MessageEvent) => {
      const msg = JSON.parse(event.data.toString())
      if (predicate(msg)) {
        clearTimeout(timer)
        ws.removeEventListener('message', handler)
        resolve(msg)
      }
    }
    ws.addEventListener('message', handler)
  })
}

/** Wait for the next message with a specific `type` field. */
function waitForType(ws: WebSocket, type: string, timeoutMs = 5000): Promise<any> {
  return waitForMessage(ws, (msg) => msg.type === type, timeoutMs)
}

/**
 * Wait for a specific message type, but also catch server errors so
 * tests fail fast with a useful message instead of timing out silently.
 */
async function waitForTypeOrError(ws: WebSocket, type: string, timeoutMs = 10000): Promise<any> {
  const msg = await waitForMessage(
    ws,
    (m) => m.type === type || m.type === 'error',
    timeoutMs,
  )
  if (msg.type === 'error') {
    throw new Error(`Expected ${type} but server returned error: ${msg.message}`)
  }
  return msg
}

/**
 * Accumulate `terminal:output` messages for a given windowId until the
 * concatenated output contains `pattern`. Rejects on timeout.
 */
function waitForOutputContaining(
  ws: WebSocket,
  windowId: number,
  pattern: string,
  timeoutMs = 10000,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let accumulated = ''
    const timer = setTimeout(() => {
      ws.removeEventListener('message', handler)
      reject(
        new Error(
          `Timeout waiting for output containing "${pattern}". ` +
            `Accumulated so far: ${JSON.stringify(accumulated)}`,
        ),
      )
    }, timeoutMs)
    const handler = (event: MessageEvent) => {
      const msg = JSON.parse(event.data.toString())
      if (msg.type === 'terminal:output' && msg.windowId === windowId) {
        accumulated += msg.data
        if (accumulated.includes(pattern)) {
          clearTimeout(timer)
          ws.removeEventListener('message', handler)
          resolve(accumulated)
        }
      }
    }
    ws.addEventListener('message', handler)
  })
}

/** Create a fresh temp directory for filesystem tests. */
async function makeTmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'nest-e2e-'))
}

/** Safely close a WebSocket, ignoring errors. */
function closeWs(ws: WebSocket): void {
  try {
    ws.close()
  } catch {}
}

/**
 * Kill a Nest session by its numeric tmux session id, ignoring errors.
 * Targets `$id` (a session), never `@id`: window ids are global across
 * tmux, so a window target could hit someone's live session.
 */
function killTmuxWindow(windowId: number): void {
  try {
    execFileSync('tmux', ['kill-session', '-t', `$${windowId}`], { stdio: 'pipe' })
  } catch {}
}

// ---------------------------------------------------------------------------
// Environment check
// ---------------------------------------------------------------------------

const TMUX_AVAILABLE = hasTmux()
const tmuxIt = TMUX_AVAILABLE ? test : test.skip
const sessionExistedBefore = TMUX_AVAILABLE && nestSessionExists()

if (!TMUX_AVAILABLE) {
  console.log('[e2e] tmux not found — tmux-dependent tests (1-5, 9) will be skipped')
} else {
  console.log(
    `[e2e] tmux available, nest session ${sessionExistedBefore ? 'already exists' : 'does not exist yet'}`,
  )
}

// ---------------------------------------------------------------------------
// Test 1: Session list matches real tmux
// ---------------------------------------------------------------------------

tmuxIt('e2e: session list matches real tmux', async () => {
  const { url, close } = await startServer(0)
  try {
    const { ws, welcome } = await connectAndWaitForWelcome(url)
    try {
      assert.equal(welcome.type, 'session:list')
      assert.ok(Array.isArray(welcome.windows))

      // Compare with actual tmux output
      let expectedNames: string[] = []
      try {
        const { stdout } = await execFileAsync('tmux', [
          'list-windows',
          '-t',
          'nest',
          '-F',
          '#{window_name}',
        ])
        expectedNames = stdout.trim().split('\n').filter(Boolean).sort()
      } catch {
        // No nest session — expect empty list
      }

      const receivedNames = welcome.windows.map((w: any) => w.name).sort()
      assert.deepEqual(receivedNames, expectedNames)
    } finally {
      closeWs(ws)
    }
  } finally {
    await close()
  }
})

// ---------------------------------------------------------------------------
// Test 2: Create window, verify in tmux
// ---------------------------------------------------------------------------

tmuxIt('e2e: create window appears in tmux', async () => {
  const { url, close } = await startServer(0)
  let windowId: number | null = null
  try {
    const { ws } = await connectAndWaitForWelcome(url)
    try {
      const createdPromise = waitForTypeOrError(ws, 'session:created')
      ws.send(JSON.stringify({ type: 'session:create', name: 'e2e-create' }))
      const created = await createdPromise
      windowId = created.window.id

      assert.equal(created.window.name, 'e2e-create')
      assert.equal(typeof windowId, 'number')

      // Verify the window exists in tmux
      const { stdout } = await execFileAsync('tmux', [
        'list-windows',
        '-t',
        'nest',
        '-F',
        '#{window_id} #{window_name}',
      ])
      assert.ok(
        stdout.includes(`@${windowId} e2e-create`),
        `Expected tmux to list window @${windowId} named e2e-create, got: ${stdout}`,
      )
    } finally {
      closeWs(ws)
    }
  } finally {
    if (windowId !== null) killTmuxWindow(windowId)
    await close()
  }
})

// ---------------------------------------------------------------------------
// Test 3: Terminal I/O round-trip
// ---------------------------------------------------------------------------

tmuxIt('e2e: terminal I/O round-trip', async () => {
  const { url, close } = await startServer(0)
  let windowId: number | null = null
  try {
    const { ws } = await connectAndWaitForWelcome(url)
    try {
      // Create a window
      const createdPromise = waitForTypeOrError(ws, 'session:created')
      ws.send(JSON.stringify({ type: 'session:create', name: 'e2e-io' }))
      const created = await createdPromise
      windowId = created.window.id

      // Start accumulating output BEFORE attaching so we don't miss anything
      const outputPromise = waitForOutputContaining(ws, windowId!, 'hello-nest-e2e', 10000)

      // Attach to the window (this spawns a pty via tmux attach-session)
      ws.send(JSON.stringify({ type: 'terminal:attach', windowId }))

      // Give the pty a moment to start up, then send the echo command
      await new Promise((r) => setTimeout(r, 1000))
      ws.send(
        JSON.stringify({ type: 'terminal:input', windowId, data: 'echo hello-nest-e2e\r' }),
      )

      // Wait for the output to contain our marker string
      const output = await outputPromise
      assert.ok(output.includes('hello-nest-e2e'), 'terminal output should contain the echoed string')
    } finally {
      closeWs(ws)
    }
  } finally {
    if (windowId !== null) killTmuxWindow(windowId)
    await close()
  }
})

// ---------------------------------------------------------------------------
// Test 4: Terminal resize
// ---------------------------------------------------------------------------

tmuxIt('e2e: terminal resize does not crash', async () => {
  const { url, close } = await startServer(0)
  let windowId: number | null = null
  try {
    const { ws } = await connectAndWaitForWelcome(url)
    try {
      // Create and attach to a window
      const createdPromise = waitForTypeOrError(ws, 'session:created')
      ws.send(JSON.stringify({ type: 'session:create', name: 'e2e-resize' }))
      const created = await createdPromise
      windowId = created.window.id

      ws.send(JSON.stringify({ type: 'terminal:attach', windowId }))
      // Wait for pty to start
      await new Promise((r) => setTimeout(r, 500))

      // Send resize — fire-and-forget, just verify it does not crash
      ws.send(JSON.stringify({ type: 'terminal:resize', windowId, cols: 120, rows: 40 }))

      // Give the server a beat to process the resize
      await new Promise((r) => setTimeout(r, 500))

      // Verify the connection is still working by requesting session list
      const listPromise = waitForType(ws, 'session:list')
      ws.send(JSON.stringify({ type: 'session:list' }))
      const list = await listPromise
      assert.ok(Array.isArray(list.windows), 'server should still respond after resize')
    } finally {
      closeWs(ws)
    }
  } finally {
    if (windowId !== null) killTmuxWindow(windowId)
    await close()
  }
})

// ---------------------------------------------------------------------------
// Test 5: Kill window, verify cleanup
// ---------------------------------------------------------------------------

tmuxIt('e2e: kill window removes it from tmux and session list', async () => {
  const { url, close } = await startServer(0)
  let windowId: number | null = null
  let windowKilled = false
  try {
    const { ws } = await connectAndWaitForWelcome(url)
    try {
      // Create a window
      const createdPromise = waitForTypeOrError(ws, 'session:created')
      ws.send(JSON.stringify({ type: 'session:create', name: 'e2e-kill' }))
      const created = await createdPromise
      windowId = created.window.id

      // Kill it via the protocol
      const killedPromise = waitForType(ws, 'session:killed')
      ws.send(JSON.stringify({ type: 'session:kill', windowId }))
      const killed = await killedPromise
      windowKilled = true

      assert.equal(killed.windowId, windowId)

      // Verify it is gone from tmux
      try {
        const { stdout } = await execFileAsync('tmux', [
          'list-windows',
          '-t',
          'nest',
          '-F',
          '#{window_id}',
        ])
        assert.ok(
          !stdout.includes(`@${windowId}`),
          `Window @${windowId} should no longer appear in tmux list-windows`,
        )
      } catch {
        // list-windows can fail if the session itself was destroyed (last
        // window killed) — that also means the window is gone.
      }

      // Verify it is gone from the Nest session list
      const listPromise = waitForType(ws, 'session:list')
      ws.send(JSON.stringify({ type: 'session:list' }))
      const list = await listPromise
      const found = list.windows.find((w: any) => w.id === windowId)
      assert.equal(found, undefined, 'killed window should not appear in session:list')
    } finally {
      closeWs(ws)
    }
  } finally {
    if (windowId !== null && !windowKilled) killTmuxWindow(windowId)
    await close()
  }
})

// ---------------------------------------------------------------------------
// Test 6: File tree matches filesystem
// ---------------------------------------------------------------------------

test('e2e: file tree matches filesystem', async () => {
  const { url, close } = await startServer(0)
  const tmpDir = await makeTmpDir()
  try {
    await fs.writeFile(path.join(tmpDir, 'alpha.txt'), 'alpha')
    await fs.mkdir(path.join(tmpDir, 'subdir'))
    await fs.writeFile(path.join(tmpDir, 'subdir', 'beta.md'), 'beta')

    const { ws } = await connectAndWaitForWelcome(url)
    try {
      const treePromise = waitForType(ws, 'files:tree')
      ws.send(JSON.stringify({ type: 'files:tree', cwd: tmpDir }))
      const tree = await treePromise

      assert.equal(tree.type, 'files:tree')
      assert.ok(Array.isArray(tree.entries))

      // Directories come first, then files, each group sorted alphabetically
      const names = tree.entries.map((e: any) => e.name)
      assert.deepEqual(names, ['subdir', 'alpha.txt'])

      const subdir = tree.entries.find((e: any) => e.name === 'subdir')
      assert.equal(subdir.type, 'dir')
      assert.equal(subdir.children.length, 1)
      assert.equal(subdir.children[0].name, 'beta.md')
      assert.equal(subdir.children[0].type, 'file')
    } finally {
      closeWs(ws)
    }
  } finally {
    await close()
    await fs.rm(tmpDir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// Test 7: File read/write round-trip
// ---------------------------------------------------------------------------

test('e2e: file read/write round-trip', async () => {
  const { url, close } = await startServer(0)
  const tmpDir = await makeTmpDir()
  try {
    const { ws } = await connectAndWaitForWelcome(url)
    try {
      // Set cwd via files:tree
      const treePromise = waitForType(ws, 'files:tree')
      ws.send(JSON.stringify({ type: 'files:tree', cwd: tmpDir }))
      await treePromise

      // Write a file via the protocol
      const savedPromise = waitForType(ws, 'files:saved')
      ws.send(
        JSON.stringify({ type: 'files:write', path: 'e2e-test.txt', content: 'e2e content' }),
      )
      const saved = await savedPromise
      assert.equal(saved.type, 'files:saved')
      assert.equal(saved.path, 'e2e-test.txt')

      // Read it back via the protocol
      const contentPromise = waitForType(ws, 'files:content')
      ws.send(JSON.stringify({ type: 'files:read', path: 'e2e-test.txt' }))
      const content = await contentPromise
      assert.equal(content.type, 'files:content')
      assert.equal(content.path, 'e2e-test.txt')
      assert.equal(content.content, 'e2e content')

      // Verify the file actually landed on disk
      const onDisk = await fs.readFile(path.join(tmpDir, 'e2e-test.txt'), 'utf-8')
      assert.equal(onDisk, 'e2e content')
    } finally {
      closeWs(ws)
    }
  } finally {
    await close()
    await fs.rm(tmpDir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// Test 8: File watch detects changes
// ---------------------------------------------------------------------------

test('e2e: file watch detects external changes', async () => {
  const { url, close } = await startServer(0)
  const tmpDir = await makeTmpDir()
  try {
    await fs.writeFile(path.join(tmpDir, 'watched.txt'), 'original')

    const { ws } = await connectAndWaitForWelcome(url)
    try {
      // Start watching
      ws.send(JSON.stringify({ type: 'files:watch', cwd: tmpDir }))
      // Give chokidar time to complete its initial scan
      await new Promise((r) => setTimeout(r, 500))

      // Mutate the file from outside (simulating an external editor)
      const changedPromise = waitForType(ws, 'files:changed')
      await fs.writeFile(path.join(tmpDir, 'watched.txt'), 'externally modified')
      const changed = await changedPromise

      assert.equal(changed.type, 'files:changed')
      assert.equal(changed.path, 'watched.txt')
      assert.equal(changed.content, 'externally modified')

      // Stop watching
      ws.send(JSON.stringify({ type: 'files:unwatch' }))
    } finally {
      closeWs(ws)
    }
  } finally {
    await close()
    await fs.rm(tmpDir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// Test 9: Two-client handoff
// ---------------------------------------------------------------------------

tmuxIt('e2e: two-client handoff with ownership tracking', async () => {
  const { url, close } = await startServer(0)
  let windowId: number | null = null
  try {
    const { ws: ws1 } = await connectAndWaitForWelcome(url)
    const { ws: ws2 } = await connectAndWaitForWelcome(url)
    try {
      // Client 1 creates a window — both clients receive the broadcast
      const c1Created = waitForTypeOrError(ws1, 'session:created')
      const c2Created = waitForTypeOrError(ws2, 'session:created')
      ws1.send(JSON.stringify({ type: 'session:create', name: 'e2e-handoff' }))
      const [created1, created2] = await Promise.all([c1Created, c2Created])
      windowId = created1.window.id
      assert.equal(created1.window.name, 'e2e-handoff')
      assert.equal(created2.window.name, 'e2e-handoff')

      // Client 1 attaches — both should receive session:ownership broadcast
      const c1Own1 = waitForType(ws1, 'session:ownership')
      const c2Own1 = waitForType(ws2, 'session:ownership')
      ws1.send(JSON.stringify({ type: 'terminal:attach', windowId }))
      const [own1a, own1b] = await Promise.all([c1Own1, c2Own1])
      assert.deepEqual(own1a.ownership, [{ windowId, clients: 1 }])
      assert.deepEqual(own1b.ownership, [{ windowId, clients: 1 }])

      // Client 2 attaches to the SAME window — Client 1 should get detached
      const c1Detached = waitForType(ws1, 'terminal:detached')
      const c1Own2 = waitForType(ws1, 'session:ownership')
      const c2Own2 = waitForType(ws2, 'session:ownership')
      ws2.send(JSON.stringify({ type: 'terminal:attach', windowId }))

      const detached = await c1Detached
      assert.equal(detached.windowId, windowId)
      assert.equal(detached.reason, 'taken-over')

      // Both should receive updated ownership (still 1 client — ws2 replaced ws1)
      const [own2a, own2b] = await Promise.all([c1Own2, c2Own2])
      assert.deepEqual(own2a.ownership, [{ windowId, clients: 1 }])
      assert.deepEqual(own2b.ownership, [{ windowId, clients: 1 }])
    } finally {
      closeWs(ws1)
      closeWs(ws2)
    }
  } finally {
    if (windowId !== null) killTmuxWindow(windowId)
    await close()
  }
})

// ---------------------------------------------------------------------------
// Test 10: Path traversal rejected end-to-end
// ---------------------------------------------------------------------------

test('e2e: path traversal is rejected', async () => {
  const { url, close } = await startServer(0)
  const tmpDir = await makeTmpDir()
  try {
    const { ws } = await connectAndWaitForWelcome(url)
    try {
      // Set cwd via files:tree
      const treePromise = waitForType(ws, 'files:tree')
      ws.send(JSON.stringify({ type: 'files:tree', cwd: tmpDir }))
      await treePromise

      // Attempt to read outside the cwd
      const errorPromise = waitForType(ws, 'error')
      ws.send(JSON.stringify({ type: 'files:read', path: '../../../etc/passwd' }))
      const error = await errorPromise

      assert.equal(error.type, 'error')
      assert.ok(typeof error.message === 'string')
      assert.ok(error.message.length > 0)
      assert.ok(
        error.message.includes('traversal') || error.message.includes('Invalid path'),
        `error message should indicate path traversal rejection, got: ${error.message}`,
      )
    } finally {
      closeWs(ws)
    }
  } finally {
    await close()
    await fs.rm(tmpDir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// Test 11: Live refresh — changes made behind Nest's back reach clients
// ---------------------------------------------------------------------------

tmuxIt('e2e: poller broadcasts session:list when tmux changes outside Nest', async () => {
  const { url, close } = await startServer(0, { pollIntervalMs: 200 })
  let windowId: number | null = null
  try {
    const { ws } = await connectAndWaitForWelcome(url)
    try {
      const createdPromise = waitForTypeOrError(ws, 'session:created')
      ws.send(JSON.stringify({ type: 'session:create', name: 'e2e-poll' }))
      const created = await createdPromise
      windowId = created.window.id
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
      await execFileAsync('tmux', ['rename-session', '-t', `$${windowId}`, 'nest_e2e-poll-moved'])
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
    if (windowId !== null) killTmuxWindow(windowId)
    await close()
  }
})

// ---------------------------------------------------------------------------
// Final cleanup: if tests created the nest session, remove it
// ---------------------------------------------------------------------------

if (TMUX_AVAILABLE) {
  test('e2e: cleanup nest session if created by tests', () => {
    if (!sessionExistedBefore && nestSessionExists()) {
      try {
        execFileSync('tmux', ['kill-session', '-t', 'nest'], { stdio: 'pipe' })
        console.log('[e2e] cleaned up nest session created by tests')
      } catch {
        // Session might already be gone
      }
    }
  })
}
