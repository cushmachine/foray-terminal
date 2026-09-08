// Session handoff (multi-client ownership), the production static server,
// and connection liveness.
//
// Run with: npx tsx --test src/server/__tests__/handoff.test.ts
//
// Covers:
//  1. terminal:attach ownership handoff: a second client attaching to a
//     window that already has a client detaches the first
//  2. session:ownership broadcasts to all clients on attach and on disconnect
//  3. the server serves a built client from its dist directory (static
//     files, SPA fallback, the build id in server:hello) and serves no
//     client at all when there is none to serve
//  4. connection liveness: `ping` gets a `pong`, a client that never answers
//     protocol pings is terminated, and terminal:attach passes its cols/rows
//     through to the pty spawner

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { WebSocket as WsClient } from 'ws'
import { connect, startTestServer, tmpDir, waitForType, wsUrl } from './helpers.ts'

// ---------------------------------------------------------------------------
// Test 1: second attach detaches the first client
// ---------------------------------------------------------------------------

test('terminal:attach: a second client taking a window detaches the first', async () => {
  const { url, close, tmux, ptys } = await startTestServer()
  tmux.add('shell')
  try {
    const { ws: ws1 } = await connect(url)
    const { ws: ws2 } = await connect(url)

    const ws1Owns = waitForType(ws1, 'session:ownership')
    ws1.send(JSON.stringify({ type: 'terminal:attach', windowId: 0 }))
    await ws1Owns
    assert.deepEqual(ptys.map((p) => p.args), [['attach-session', '-t', '$0']])

    // ws2 attaches to the SAME window: ws1 is told it was taken over.
    const detached = waitForType(ws1, 'terminal:detached')
    ws2.send(JSON.stringify({ type: 'terminal:attach', windowId: 0 }))

    const detachedMsg = await detached
    assert.equal(detachedMsg.windowId, 0)
    assert.equal(detachedMsg.reason, 'taken-over')
    assert.equal(ptys.length, 2, 'each attach spawns its own pty')
    // The loser's pty is gone too, not left as a second tmux client that
    // keeps the session sized to a screen nobody is looking at.
    assert.equal(ptys[0].killed, true, 'the taken-over client\'s pty is killed server-side')
    assert.equal(ptys[1].killed, false)

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
  const { url, close, tmux } = await startTestServer()
  tmux.add('shell')
  try {
    const { ws: ws1 } = await connect(url)
    const { ws: ws2 } = await connect(url)

    const ws1Ownership = waitForType(ws1, 'session:ownership')
    const ws2Ownership = waitForType(ws2, 'session:ownership')
    ws1.send(JSON.stringify({ type: 'terminal:attach', windowId: 0 }))

    const [msg1, msg2] = await Promise.all([ws1Ownership, ws2Ownership])
    assert.deepEqual(msg1.ownership, [{ windowId: 0, clients: 1 }])
    assert.deepEqual(msg2.ownership, [{ windowId: 0, clients: 1 }])

    // ws1 disconnects: ws2 sees a snapshot with window 0 no longer listed.
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
// Test 3: the production static server
// ---------------------------------------------------------------------------

const INDEX_HTML =
  '<!doctype html><html><head><meta name="nest-build" content="abc1234.k1"></head>' +
  '<body><div id="root"></div></body></html>'

test('the server serves a built client from its dist dir, with the SPA fallback', async () => {
  const root = await tmpDir('nest-dist-')
  const dist = path.join(root, 'dist')
  await fs.mkdir(path.join(dist, 'assets'), { recursive: true })
  await fs.writeFile(path.join(dist, 'index.html'), INDEX_HTML)
  await fs.writeFile(path.join(dist, 'assets', 'app.js'), 'console.log("app")')
  const { url, close } = await startTestServer({ clientDist: dist })
  try {
    const health = await fetch(`${url}/health`)
    assert.equal(health.status, 200)
    assert.deepEqual(await health.json(), { status: 'ok' })

    const index = await fetch(`${url}/`)
    assert.equal(index.status, 200)
    assert.equal(await index.text(), INDEX_HTML)

    const asset = await fetch(`${url}/assets/app.js`)
    assert.equal(asset.status, 200)
    assert.equal(await asset.text(), 'console.log("app")')

    // A client-side route reloads to index.html, not a 404.
    const deep = await fetch(`${url}/some/client/route`)
    assert.equal(deep.status, 200)
    assert.equal(await deep.text(), INDEX_HTML)

    // The version handshake reports the build id of that same index.html.
    const { ws } = await connect(url)
    const hello = waitForType(ws, 'server:hello')
    ws.send(JSON.stringify({ type: 'client:hello', build: null }))
    assert.equal((await hello).clientBuild, 'abc1234.k1')
    ws.close()
  } finally {
    await close()
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('a server with no client dir serves the API only', async () => {
  const { url, close } = await startTestServer()
  try {
    assert.equal((await fetch(`${url}/health`)).status, 200)
    assert.equal((await fetch(`${url}/`)).status, 404)
  } finally {
    await close()
  }
})

// ---------------------------------------------------------------------------
// Test 4: liveness: ping/pong, dead-client termination, attach size
// ---------------------------------------------------------------------------

test('ping is answered with pong', async () => {
  const { url, close } = await startTestServer()
  try {
    const { ws } = await connect(url)
    const pong = waitForType(ws, 'pong')
    ws.send(JSON.stringify({ type: 'ping' }))
    assert.deepEqual(await pong, { type: 'pong' })
    ws.close()
  } finally {
    await close()
  }
})

test('a client that never answers protocol pings is terminated', async () => {
  const { url, close } = await startTestServer({ heartbeatIntervalMs: 50 })
  try {
    // The `ws` client can be told not to auto-reply to pings; the browser
    // and Node's built-in WebSocket always do, which is why they stay alive.
    const ws = new WsClient(wsUrl(url), { autoPong: false })
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
  const { url, close } = await startTestServer({ heartbeatIntervalMs: 30 })
  try {
    // The `ws` client surfaces the protocol pings it answers (the built-in
    // WebSocket answers them silently), so the test can count ticks
    // instead of guessing how long several of them take.
    const ws = new WsClient(wsUrl(url))
    await new Promise<void>((resolve, reject) => {
      ws.once('message', () => resolve())
      ws.once('error', reject)
    })
    let closedEarly = false
    ws.once('close', () => {
      closedEarly = true
    })
    let pings = 0
    await new Promise<void>((resolve) => {
      ws.on('ping', () => {
        if (++pings === 3) resolve()
      })
    })
    assert.equal(closedEarly, false, 'a responsive client must not be terminated')
    ws.close()
  } finally {
    await close()
  }
})

test('terminal:attach passes cols/rows through to the pty spawner', async () => {
  const { url, close, tmux, ptys } = await startTestServer()
  tmux.add('one')
  tmux.add('two')
  try {
    const { ws } = await connect(url)

    const owned = waitForType(ws, 'session:ownership')
    ws.send(JSON.stringify({ type: 'terminal:attach', windowId: 0, cols: 100, rows: 30 }))
    await owned
    assert.deepEqual(ptys.map(({ cols, rows }) => ({ cols, rows })), [{ cols: 100, rows: 30 }])

    // Without a size the pty falls back to the historical 80x24.
    const ownedAgain = waitForType(ws, 'session:ownership')
    ws.send(JSON.stringify({ type: 'terminal:attach', windowId: 1 }))
    await ownedAgain
    assert.deepEqual({ cols: ptys[1].cols, rows: ptys[1].rows }, { cols: 80, rows: 24 })

    ws.close()
  } finally {
    await close()
  }
})
