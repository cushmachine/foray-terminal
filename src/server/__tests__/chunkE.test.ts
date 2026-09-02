// Chunk E tests: session handoff (multi-client ownership) + deployment config.
//
// Run with: npm run test:chunkE
// (executed directly via `tsx`, using node's built-in test runner)
//
// Covers:
//  1. terminal:attach ownership handoff — a second client attaching to a
//     window that already has a client detaches the first
//  2. session:ownership broadcasts to all clients on attach and on disconnect
//  3. `npm run build` produces dist/ with client files (index.html + assets)
//  4. the production server (NODE_ENV=production) serves the built client
//     from dist/ at the project root — the fix for the __dirname-based path
//     bug, plus a health-check sanity check
//  5. connection liveness: `ping` gets a `pong`, a client that never answers
//     protocol pings is terminated, and terminal:attach passes its cols/rows
//     through to the pty spawner

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs/promises'
import path from 'node:path'
import { WebSocket as WsClient } from 'ws'
import { startServer } from '../index.ts'
import type { PtySpawner } from '../pty-bridge.ts'

const execFileAsync = promisify(execFile)

/** Connect a WebSocket and resolve once the welcome message arrives. */
async function connectAndWaitForWelcome(url: string): Promise<WebSocket> {
  const wsUrl = url.replace(/^http/, 'ws') + '/ws'
  const ws = new WebSocket(wsUrl)
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('timed out waiting for welcome')), 5000)
    ws.addEventListener(
      'message',
      () => {
        clearTimeout(timeout)
        resolve()
      },
      { once: true },
    )
    ws.addEventListener('error', reject)
  })
  return ws
}

/** Wait for the next message of a given type on a socket (ignores others). */
function waitForType(ws: WebSocket, type: string, timeoutMs = 5000): Promise<any> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error(`timed out waiting for message of type "${type}"`)),
      timeoutMs,
    )
    const handler = (event: MessageEvent) => {
      const msg = JSON.parse(event.data.toString())
      if (msg.type === type) {
        clearTimeout(timeout)
        ws.removeEventListener('message', handler)
        resolve(msg)
      }
    }
    ws.addEventListener('message', handler)
  })
}

// ---------------------------------------------------------------------------
// Test 1: second attach detaches the first client
// ---------------------------------------------------------------------------

test('terminal:attach: a second client taking a window detaches the first', async () => {
  const { url, close } = await startServer(0)
  try {
    const ws1 = await connectAndWaitForWelcome(url)
    const ws2 = await connectAndWaitForWelcome(url)

    // ws1 attaches to window 0 first. There's no real tmux running in this
    // test environment, so the pty spawn itself will fail — but ownership
    // tracking should still register the attach (a session:ownership
    // broadcast should still go out).
    const ws1Owns = waitForType(ws1, 'session:ownership')
    ws1.send(JSON.stringify({ type: 'terminal:attach', windowId: 0 }))
    await ws1Owns

    // ws2 attaches to the SAME window — ws1 should be told it was taken over.
    const detached = waitForType(ws1, 'terminal:detached')
    ws2.send(JSON.stringify({ type: 'terminal:attach', windowId: 0 }))

    const detachedMsg = await detached
    assert.equal(detachedMsg.windowId, 0)
    assert.equal(detachedMsg.reason, 'taken-over')

    ws1.close()
    ws2.close()
  } finally {
    await close()
  }
})

// ---------------------------------------------------------------------------
// Test 2: ownership state broadcasts to all clients, including on disconnect
// ---------------------------------------------------------------------------

test('session:ownership broadcasts to all clients on attach and on disconnect', async () => {
  const { url, close } = await startServer(0)
  try {
    const ws1 = await connectAndWaitForWelcome(url)
    const ws2 = await connectAndWaitForWelcome(url)

    const ws1Ownership = waitForType(ws1, 'session:ownership')
    const ws2Ownership = waitForType(ws2, 'session:ownership')
    ws1.send(JSON.stringify({ type: 'terminal:attach', windowId: 0 }))

    const [msg1, msg2] = await Promise.all([ws1Ownership, ws2Ownership])
    assert.deepEqual(msg1.ownership, [{ windowId: 0, clients: 1 }])
    assert.deepEqual(msg2.ownership, [{ windowId: 0, clients: 1 }])

    // ws1 disconnects — ws2 (still connected) should see an updated
    // ownership snapshot with window 0 no longer listed.
    const updatedOwnership = waitForType(ws2, 'session:ownership')
    ws1.close()

    const updated = await updatedOwnership
    assert.deepEqual(updated.ownership, [])

    ws2.close()
  } finally {
    await close()
  }
})

// ---------------------------------------------------------------------------
// Test 3: `npm run build` produces dist/ with client files
// ---------------------------------------------------------------------------

test('npm run build produces dist/ with index.html and JS/CSS assets', async () => {
  const projectRoot = process.cwd()

  await execFileAsync('npm', ['run', 'build'], {
    cwd: projectRoot,
    maxBuffer: 20 * 1024 * 1024,
  })

  const distDir = path.join(projectRoot, 'dist')
  const indexHtml = await fs.readFile(path.join(distDir, 'index.html'), 'utf-8')
  assert.ok(indexHtml.includes('<div id="root">'), 'dist/index.html should contain the app root element')

  const assetFiles = await fs.readdir(path.join(distDir, 'assets'))
  assert.ok(assetFiles.some((f) => f.endsWith('.js')), 'dist/assets should contain a .js bundle')
  assert.ok(assetFiles.some((f) => f.endsWith('.css')), 'dist/assets should contain a .css bundle')
})

// ---------------------------------------------------------------------------
// Test 4: production server serves the built client from <project-root>/dist
// ---------------------------------------------------------------------------

test('production server serves the built client and responds to health checks', async () => {
  const originalNodeEnv = process.env.NODE_ENV
  process.env.NODE_ENV = 'production'
  try {
    const { url, close } = await startServer(0)
    try {
      const health = await fetch(`${url}/health`)
      assert.equal(health.status, 200)
      assert.deepEqual(await health.json(), { status: 'ok' })

      const root = await fetch(`${url}/`)
      assert.equal(root.status, 200)
      const html = await root.text()
      assert.ok(html.includes('<div id="root">'), 'production server should serve the built index.html')
    } finally {
      await close()
    }
  } finally {
    process.env.NODE_ENV = originalNodeEnv
  }
})


// ---------------------------------------------------------------------------
// Test 5: liveness — ping/pong, dead-client termination, attach size
// ---------------------------------------------------------------------------

test('ping is answered with pong', async () => {
  const { url, close } = await startServer(0)
  try {
    const ws = await connectAndWaitForWelcome(url)
    const pong = waitForType(ws, 'pong')
    ws.send(JSON.stringify({ type: 'ping' }))
    assert.deepEqual(await pong, { type: 'pong' })
    ws.close()
  } finally {
    await close()
  }
})

test('a client that never answers protocol pings is terminated', async () => {
  const { url, close } = await startServer(0, { heartbeatIntervalMs: 50 })
  try {
    // The `ws` client can be told not to auto-reply to pings; the browser
    // and Node's built-in WebSocket always do, which is why they stay alive.
    const wsUrl = url.replace(/^http/, 'ws') + '/ws'
    const ws = new WsClient(wsUrl, { autoPong: false })
    await new Promise<void>((resolve, reject) => {
      ws.once('message', () => resolve())
      ws.once('error', reject)
    })

    const closed = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('server never closed the silent client')), 2000)
      ws.once('close', () => {
        clearTimeout(timeout)
        resolve()
      })
    })
    await closed
  } finally {
    await close()
  }
})

test('a client that answers protocol pings stays connected across several ticks', async () => {
  const { url, close } = await startServer(0, { heartbeatIntervalMs: 30 })
  try {
    const ws = await connectAndWaitForWelcome(url)
    let closedEarly = false
    ws.addEventListener('close', () => {
      closedEarly = true
    })
    await new Promise((resolve) => setTimeout(resolve, 200))
    assert.equal(closedEarly, false, 'a responsive client must not be terminated')
    ws.close()
  } finally {
    await close()
  }
})

test('terminal:attach passes cols/rows through to the pty spawner', async () => {
  const spawned: Array<{ cols: number; rows: number }> = []
  const ptySpawner: PtySpawner = (_file, _args, options) => {
    spawned.push({ cols: options.cols, rows: options.rows })
    return { onData: () => {}, write: () => {}, resize: () => {}, kill: () => {} }
  }
  const { url, close } = await startServer(0, { ptySpawner })
  try {
    const ws = await connectAndWaitForWelcome(url)

    const owned = waitForType(ws, 'session:ownership')
    ws.send(JSON.stringify({ type: 'terminal:attach', windowId: 0, cols: 100, rows: 30 }))
    await owned
    assert.deepEqual(spawned, [{ cols: 100, rows: 30 }])

    // Without a size the pty falls back to the historical 80x24.
    const ownedAgain = waitForType(ws, 'session:ownership')
    ws.send(JSON.stringify({ type: 'terminal:attach', windowId: 1 }))
    await ownedAgain
    assert.deepEqual(spawned[1], { cols: 80, rows: 24 })

    ws.close()
  } finally {
    await close()
  }
})
