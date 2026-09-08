// Connection lifecycle: message ordering, attach races, detach, pty exit,
// kill, resize bursts, backpressure and early socket errors.
//
// Run with: npx tsx --test src/server/__tests__/connection.test.ts

import { test } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import net from 'node:net'
import type { TmuxExecutor } from '../tmux.ts'
import {
  connect, fakeTmux, handleTestConnection, startTestServer, until, waitForType, type Msg,
} from './helpers.ts'

// ---------------------------------------------------------------------------
// Per-connection FIFO
// ---------------------------------------------------------------------------

// Messages on one socket are handled in order, so a keystroke that follows
// an attach finds the pty it was typed into, and a pong proves everything
// sent before the ping is done.
test('input sent right after attach reaches the pty', async () => {
  const { url, close, tmux, ptys } = await startTestServer()
  tmux.add('shell')
  try {
    const { ws } = await connect(url)
    ws.send(JSON.stringify({ type: 'terminal:attach', windowId: 0 }))
    ws.send(JSON.stringify({ type: 'terminal:input', windowId: 0, data: 'ls\r' }))
    const pong = waitForType(ws, 'pong')
    ws.send(JSON.stringify({ type: 'ping' }))
    await pong

    assert.equal(ptys.length, 1)
    assert.deepEqual(ptys[0].writes, ['ls\r'], 'the input that followed the attach was written to its pty')
    ws.close()
  } finally {
    await close()
  }
})

test('two attaches for one window on one connection leave one live pty', async () => {
  const { url, close, tmux, ptys } = await startTestServer()
  tmux.add('shell')
  try {
    const { ws } = await connect(url)
    ws.send(JSON.stringify({ type: 'terminal:attach', windowId: 0 }))
    ws.send(JSON.stringify({ type: 'terminal:attach', windowId: 0 }))
    const pong = waitForType(ws, 'pong')
    ws.send(JSON.stringify({ type: 'ping' }))
    await pong

    const live = ptys.filter((p) => !p.killed)
    assert.equal(live.length, 1, `expected one live pty, found ${live.length} of ${ptys.length} spawned`)
    assert.equal(ptys[0].killed, true, 'the first attach\'s pty is killed by the second')
    ws.close()
  } finally {
    await close()
  }
})

// ---------------------------------------------------------------------------
// Closing mid-attach
// ---------------------------------------------------------------------------

test('closing mid-attach leaves no pty and no phantom owner', async () => {
  const tmux = fakeTmux()
  tmux.add('shell')
  tmux.add('other')
  // Hold the first history query until the test says so.
  let gated = false
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const exec: TmuxExecutor = async (cmd, args) => {
    if (args[0] === 'display-message' && !gated) {
      gated = true
      await gate
    }
    return tmux.exec(cmd, args)
  }
  const { url, close, ptys } = await startTestServer({ tmuxExec: exec })
  try {
    const { ws: ws1 } = await connect(url)
    const { ws: ws2 } = await connect(url)

    ws1.send(JSON.stringify({ type: 'terminal:attach', windowId: 0 }))
    await until(() => gated, 'the attach to reach tmux')

    // ws1 goes away while tmux is still answering; the close handler's
    // release broadcast tells us the server has processed the close.
    const released = waitForType(ws2, 'session:ownership')
    ws1.close()
    await released
    release()
    // The stalled attach resumes on the microtask queue; one turn of the
    // event loop is enough for it to run to its end.
    await new Promise((resolve) => setImmediate(resolve))

    const live = ptys.filter((p) => !p.killed)
    assert.equal(live.length, 0, 'a late attach must not leave a pty for a closed socket')

    // Ownership reflects only the connections that exist.
    const ownership = waitForType(ws2, 'session:ownership')
    ws2.send(JSON.stringify({ type: 'terminal:attach', windowId: 1 }))
    assert.deepEqual((await ownership).ownership, [{ windowId: 1, clients: 1 }])
    ws2.close()
  } finally {
    release()
    await close()
  }
})

// ---------------------------------------------------------------------------
// Detach, exit, kill
// ---------------------------------------------------------------------------

test('terminal:detach kills the pty and releases ownership', async () => {
  const { url, close, tmux, ptys } = await startTestServer()
  tmux.add('shell')
  try {
    const { ws } = await connect(url)
    const attached = waitForType(ws, 'session:ownership')
    ws.send(JSON.stringify({ type: 'terminal:attach', windowId: 0 }))
    assert.deepEqual((await attached).ownership, [{ windowId: 0, clients: 1 }])

    const ownership = waitForType(ws, 'session:ownership', 1000)
    // Awaited below; if the assertion before it fails, its timeout must not
    // surface as a stray rejection after the test ended.
    ownership.catch(() => {})
    const pong = waitForType(ws, 'pong')
    ws.send(JSON.stringify({ type: 'terminal:detach', windowId: 0 }))
    ws.send(JSON.stringify({ type: 'ping' }))
    await pong
    assert.equal(ptys[0].killed, true, 'detach kills the pty')
    assert.deepEqual((await ownership).ownership, [], 'detach releases ownership')
    ws.close()
  } finally {
    await close()
  }
})

test('a pty exit sends terminal:exited and drops the handle', async () => {
  const { url, close, tmux, ptys } = await startTestServer()
  tmux.add('shell')
  try {
    const { ws } = await connect(url)
    const attached = waitForType(ws, 'terminal:history')
    ws.send(JSON.stringify({ type: 'terminal:attach', windowId: 0 }))
    await attached
    assert.equal(ptys.length, 1)

    const exited = waitForType(ws, 'terminal:exited', 1000)
    ptys[0].exit(0)
    assert.equal((await exited).windowId, 0)

    // Input after the exit has nowhere to go.
    const pong = waitForType(ws, 'pong')
    ws.send(JSON.stringify({ type: 'terminal:input', windowId: 0, data: 'late\r' }))
    ws.send(JSON.stringify({ type: 'ping' }))
    await pong
    assert.deepEqual(ptys[0].writes, [], 'no writes into an exited pty')
    ws.close()
  } finally {
    await close()
  }
})

test('session:kill kills the ptys attached to that window on every connection', async () => {
  const { url, close, tmux, ptys } = await startTestServer()
  tmux.add('shell')
  tmux.add('other')
  try {
    const { ws: viewer } = await connect(url)
    const { ws: killer } = await connect(url)
    const attached = waitForType(viewer, 'terminal:history')
    viewer.send(JSON.stringify({ type: 'terminal:attach', windowId: 0 }))
    await attached
    assert.equal(ptys.length, 1)

    // Waited for on the killer's own socket: the ownership broadcast that
    // drops the dead window precedes session:killed there, so the snapshot
    // waited for below is the one the next attach produces.
    const killed = waitForType(killer, 'session:killed')
    killer.send(JSON.stringify({ type: 'session:kill', windowId: 0 }))
    await killed
    assert.equal(ptys[0].killed, true, 'the viewer\'s pty for the killed window is killed')

    // The dead window is gone from ownership too: the next snapshot lists
    // only the window the killer attaches to now.
    const ownership = waitForType(killer, 'session:ownership')
    killer.send(JSON.stringify({ type: 'terminal:attach', windowId: 1 }))
    assert.deepEqual((await ownership).ownership, [{ windowId: 1, clients: 1 }])
    viewer.close()
    killer.close()
  } finally {
    await close()
  }
})

// ---------------------------------------------------------------------------
// Resize bursts
// ---------------------------------------------------------------------------

/** Every message of `type` that arrives within `ms`. */
function collect(ws: WebSocket, type: string, ms: number): Promise<Msg[]> {
  return new Promise((resolve) => {
    const seen: Msg[] = []
    const handler = (event: MessageEvent): void => {
      const msg = JSON.parse(String(event.data)) as Msg
      if (msg.type === type) seen.push(msg)
    }
    ws.addEventListener('message', handler)
    setTimeout(() => {
      ws.removeEventListener('message', handler)
      resolve(seen)
    }, ms)
  })
}

// A phone rotating, or a desktop window being dragged, sends a burst of
// resizes; tmux reflows the history after each, so the whole history is
// re-sent once, after the burst settles, not once per resize.
test('ten resizes in 50 ms cause one history re-send', async () => {
  const { url, close, tmux } = await startTestServer()
  tmux.add('shell', { history: ['one', 'two', 'three'] })
  try {
    const { ws } = await connect(url)
    const attached = waitForType(ws, 'terminal:history')
    ws.send(JSON.stringify({ type: 'terminal:attach', windowId: 0, cols: 80, rows: 24 }))
    await attached

    const resends = collect(ws, 'terminal:history', 700)
    for (let i = 0; i < 10; i++) {
      ws.send(JSON.stringify({ type: 'terminal:resize', windowId: 0, cols: 60 + i, rows: 24 }))
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    const got = await resends
    assert.equal(got.length, 1, `expected one history re-send after the storm, got ${got.length}`)
    assert.equal(got[0].reset, true)
    ws.close()
  } finally {
    await close()
  }
})

// ---------------------------------------------------------------------------
// Backpressure
// ---------------------------------------------------------------------------

const CHUNK = 'x'.repeat(64 * 1024)
const CHUNKS = 80 // 5 MB

test('a flooding pty is paused while the socket buffer is high and resumed once drained', async () => {
  const conn = handleTestConnection()
  conn.tmux.add('shell')
  conn.socket.receive({ type: 'terminal:attach', windowId: 0 })
  await until(() => conn.ptys.length === 1, 'the pty to spawn')
  const pty = conn.ptys[0]

  // The client is not keeping up: the socket reports megabytes queued.
  conn.socket.bufferedAmount = 4 * 1024 * 1024
  for (let i = 0; i < CHUNKS; i++) pty.emit(CHUNK)
  assert.ok(pty.pauses > 0, 'pty.pause() while the socket has more than the high-water mark buffered')

  conn.socket.bufferedAmount = 0
  await until(() => pty.resumes > 0, 'pty.resume() once the socket drained')
  assert.equal(pty.resumes, pty.pauses, 'every pause is matched by one resume')
  conn.socket.emit('close')
})

// ---------------------------------------------------------------------------
// Socket errors before the welcome
// ---------------------------------------------------------------------------

/** Complete a WebSocket upgrade by hand so we can write raw frames afterwards. */
function rawUpgrade(url: string): Promise<net.Socket> {
  const { hostname, port } = new URL(url)
  return new Promise((resolve, reject) => {
    const socket = net.connect(Number(port), hostname, () => {
      const key = crypto.randomBytes(16).toString('base64')
      socket.write(
        `GET /ws HTTP/1.1\r\nHost: ${hostname}:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
        `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
      )
    })
    socket.once('data', (data) => {
      const status = String(data).split('\r\n')[0]
      if (status.startsWith('HTTP/1.1 101')) resolve(socket)
      else reject(new Error(`upgrade refused: ${status}`))
    })
    socket.once('error', reject)
  })
}

/** A masked frame with RSV1 set: no extension was negotiated, so ws rejects it. */
const BAD_FRAME = Buffer.from([0xf1, 0x80, 0, 0, 0, 0])

// The welcome awaits tmux; a socket that errors during that wait (a bad
// frame from a half-dead phone) must already have an error listener, or
// the EventEmitter throw takes the whole server down.
test('a socket error before the welcome completes does not crash the process', async () => {
  const tmux = fakeTmux()
  // Hold the welcome's session list so the error lands during the await.
  let listing = false
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const exec: TmuxExecutor = async (cmd, args) => {
    if (args[0] === 'list-sessions') {
      listing = true
      await gate
    }
    return tmux.exec(cmd, args)
  }
  const { url, close } = await startTestServer({ tmuxExec: exec })
  const uncaught: unknown[] = []
  const onUncaught = (err: unknown): void => {
    uncaught.push(err)
  }
  process.on('uncaughtException', onUncaught)
  try {
    const socket = await rawUpgrade(url)
    await until(() => listing, 'the welcome to reach tmux')
    // ws answers a protocol error by closing the connection; the server's
    // FIN is the sign the error has been raised and handled.
    const ended = new Promise<void>((resolve) => socket.once('end', resolve))
    socket.write(BAD_FRAME)
    await ended
    release()
    // The welcome resumes on the microtask queue and sends into the
    // closed socket; one turn of the event loop lets it finish.
    await new Promise((resolve) => setImmediate(resolve))
    socket.destroy()

    assert.deepEqual(uncaught, [], 'the socket error escaped as an uncaught exception')
  } finally {
    process.off('uncaughtException', onUncaught)
    release()
    await close()
  }
})
