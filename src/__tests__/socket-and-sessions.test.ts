// WebSocket connection manager (SocketManager) and session-list reducer
// (applySessionMessage) tests.
//
// Run with: npx tsx --test src/__tests__/socket-and-sessions.test.ts
// (executed directly via `tsx`, using node's built-in test runner)
//
// SocketManager and applySessionMessage are framework-agnostic (no React,
// no DOM) — the React-specific pieces (the useSocket hook, and the
// App/Terminal/Sidebar components that consume it) are thin wrappers
// around this tested core, so we drive the core directly here with a mock
// WebSocket rather than trying to render components without a DOM.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  SocketManager,
  computeBackoffDelay,
  type SocketManagerOptions,
  type WebSocketLike,
} from '../hooks/useSocket.ts'
import { applySessionMessage, displayName } from '../sessionState.ts'
import type { ServerMessage, TmuxWindow } from '../shared/protocol.ts'

// ---------------------------------------------------------------------------
// Mock WebSocket
// ---------------------------------------------------------------------------

const OPEN = 1
const CLOSED = 3

class MockSocket implements WebSocketLike {
  readyState = 0
  sent: string[] = []
  onopen: ((ev: unknown) => void) | null = null
  onclose: ((ev: unknown) => void) | null = null
  onerror: ((ev: unknown) => void) | null = null
  onmessage: ((ev: { data: unknown }) => void) | null = null

  constructor(public url: string) {}

  send(data: string) {
    this.sent.push(data)
  }

  close() {
    this.readyState = CLOSED
    this.onclose?.({})
  }

  // Test helpers — simulate the browser driving the socket's lifecycle.
  triggerOpen() {
    this.readyState = OPEN
    this.onopen?.({})
  }

  triggerClose() {
    this.readyState = CLOSED
    this.onclose?.({})
  }

  triggerMessage(msg: ServerMessage) {
    this.onmessage?.({ data: JSON.stringify(msg) })
  }
}

function makeManager(backoffMs = 5, options: Partial<SocketManagerOptions> = {}) {
  const instances: MockSocket[] = []
  const manager = new SocketManager('ws://test/ws', {
    factory: (url) => {
      const sock = new MockSocket(url)
      instances.push(sock)
      return sock
    },
    backoff: () => backoffMs,
    // Off unless a test opts in, so the connection tests stay deterministic.
    heartbeatIntervalMs: 0,
    ...options,
  })
  return { manager, instances }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const sentTypes = (sock: MockSocket) => sock.sent.map((raw) => JSON.parse(raw).type as string)

// ---------------------------------------------------------------------------
// Test 1: SocketManager connection state machine + reconnect scheduling
// ---------------------------------------------------------------------------

test('SocketManager: starts in connecting state', () => {
  const { manager } = makeManager()
  assert.equal(manager.status, 'connecting')
  manager.close()
})

test('SocketManager: transitions to connected on open', () => {
  const { manager, instances } = makeManager()
  const statuses: string[] = []
  manager.onStatusChange((s) => statuses.push(s))

  instances[0].triggerOpen()

  assert.equal(manager.status, 'connected')
  assert.deepEqual(statuses, ['connected'])
  manager.close()
})

test('SocketManager: transitions to disconnected on close and schedules a reconnect', async () => {
  const { manager, instances } = makeManager(5)
  instances[0].triggerOpen()
  assert.equal(manager.status, 'connected')

  instances[0].triggerClose()
  assert.equal(manager.status, 'disconnected')
  assert.equal(instances.length, 1, 'reconnect should be scheduled, not immediate')

  // Wait past the (mocked, 5ms) backoff delay for the reconnect to fire.
  await new Promise((resolve) => setTimeout(resolve, 40))

  assert.equal(instances.length, 2, 'a new socket should have been created for the reconnect')
  assert.equal(manager.status, 'connecting')

  manager.close()
})

test('SocketManager: close() stops further reconnect attempts', async () => {
  const { manager, instances } = makeManager(5)
  instances[0].triggerOpen()
  instances[0].triggerClose()

  manager.close()
  await new Promise((resolve) => setTimeout(resolve, 40))

  assert.equal(instances.length, 1, 'a closed manager should not reconnect')
})

test('computeBackoffDelay: exponential with a 10s cap (1s, 2s, 4s, 8s, capped at 10s)', () => {
  assert.equal(computeBackoffDelay(0), 1000)
  assert.equal(computeBackoffDelay(1), 2000)
  assert.equal(computeBackoffDelay(2), 4000)
  assert.equal(computeBackoffDelay(3), 8000)
  assert.equal(computeBackoffDelay(4), 10000)
  assert.equal(computeBackoffDelay(10), 10000)
})

// ---------------------------------------------------------------------------
// Test 2: message routing — the session-list reducer
// ---------------------------------------------------------------------------

const WIN_A: TmuxWindow = {
  id: 0, name: 'shell', cwd: '/home/user', title: '', command: 'bash', named: false,
}
const WIN_B: TmuxWindow = {
  id: 1, name: 'claude', cwd: '/home/user/project', title: '', command: 'claude', named: false,
}

test('applySessionMessage: session:list replaces the session list', () => {
  const result = applySessionMessage([], { type: 'session:list', windows: [WIN_A, WIN_B] })
  assert.deepEqual(result, [WIN_A, WIN_B])
})

test('applySessionMessage: session:created appends a new session', () => {
  const result = applySessionMessage([WIN_A], { type: 'session:created', window: WIN_B })
  assert.deepEqual(result, [WIN_A, WIN_B])
})

test('applySessionMessage: session:created is idempotent for a duplicate id', () => {
  const start = [WIN_A, WIN_B]
  const result = applySessionMessage(start, { type: 'session:created', window: WIN_B })
  assert.deepEqual(result, start)
})

test('applySessionMessage: session:killed removes the matching session', () => {
  const result = applySessionMessage([WIN_A, WIN_B], { type: 'session:killed', windowId: WIN_A.id })
  assert.deepEqual(result, [WIN_B])
})

test('applySessionMessage: session:renamed updates the name in place', () => {
  const result = applySessionMessage([WIN_A, WIN_B], {
    type: 'session:renamed',
    windowId: WIN_B.id,
    name: 'renamed',
  })
  assert.deepEqual(result, [WIN_A, { ...WIN_B, name: 'renamed', named: true }])
})

test('displayName: auto-named session with no title shows the session name', () => {
  assert.equal(displayName(WIN_A), 'shell')
})

test('displayName: auto-named session shows the live program title over "bash"', () => {
  const win: TmuxWindow = { ...WIN_A, name: 'bash', title: '✳ Test session', command: 'claude' }
  assert.equal(displayName(win), '✳ Test session')
})

test('displayName: an explicit Nest name beats the program title', () => {
  const win: TmuxWindow = { ...WIN_A, name: 'deploy', title: '✳ Test session', named: true }
  assert.equal(displayName(win), 'deploy')
})

test('applySessionMessage: unrelated messages are a no-op (same reference back)', () => {
  const start = [WIN_A]
  const result = applySessionMessage(start, { type: 'terminal:output', windowId: 0, data: 'hi' })
  assert.equal(result, start)
})

// ---------------------------------------------------------------------------
// Test 3: send() queues while disconnected, flushes on open
// ---------------------------------------------------------------------------

test('SocketManager.send: queues messages while disconnected, flushes in order on open', () => {
  const { manager, instances } = makeManager()
  const sock = instances[0]

  manager.send({ type: 'terminal:attach', windowId: 0 })
  manager.send({ type: 'terminal:input', windowId: 0, data: 'ls\n' })

  assert.deepEqual(sock.sent, [], 'nothing should be sent before the socket opens')

  sock.triggerOpen()

  assert.equal(sock.sent.length, 2)
  assert.deepEqual(JSON.parse(sock.sent[0]), { type: 'terminal:attach', windowId: 0 })
  assert.deepEqual(JSON.parse(sock.sent[1]), { type: 'terminal:input', windowId: 0, data: 'ls\n' })

  manager.close()
})

test('SocketManager.send: sends immediately once connected', () => {
  const { manager, instances } = makeManager()
  const sock = instances[0]
  sock.triggerOpen()

  manager.send({ type: 'session:list' })

  assert.equal(sock.sent.length, 1)
  assert.deepEqual(JSON.parse(sock.sent[0]), { type: 'session:list' })

  manager.close()
})

test('SocketManager.onMessage: delivers parsed server messages and supports unsubscribe', () => {
  const { manager, instances } = makeManager()
  const sock = instances[0]
  sock.triggerOpen()

  const received: ServerMessage[] = []
  const unsubscribe = manager.onMessage((msg) => received.push(msg))

  sock.triggerMessage({ type: 'session:list', windows: [WIN_A] })
  assert.equal(received.length, 1)
  assert.deepEqual(received[0], { type: 'session:list', windows: [WIN_A] })

  unsubscribe()
  sock.triggerMessage({ type: 'session:list', windows: [WIN_B] })
  assert.equal(received.length, 1, 'handler should not fire after unsubscribe')

  manager.close()
})


// ---------------------------------------------------------------------------
// Test 4: heartbeat — pings while connected, drops a silent socket
// ---------------------------------------------------------------------------

test('SocketManager heartbeat: sends ping on the interval once connected', async () => {
  const { manager, instances } = makeManager(5, { heartbeatIntervalMs: 10, heartbeatTimeoutMs: 1000 })
  const sock = instances[0]
  sock.triggerOpen()

  await sleep(25)
  assert.ok(sentTypes(sock).includes('ping'), 'a ping should have gone out')

  manager.close()
})

test('SocketManager heartbeat: a pong keeps the connection alive', async () => {
  const { manager, instances } = makeManager(5, { heartbeatIntervalMs: 10, heartbeatTimeoutMs: 15 })
  const sock = instances[0]
  sock.triggerOpen()
  // Behave like a healthy server: answer every ping.
  const origSend = sock.send.bind(sock)
  sock.send = (data: string) => {
    origSend(data)
    if (JSON.parse(data).type === 'ping') sock.triggerMessage({ type: 'pong' })
  }

  await sleep(60)
  assert.equal(instances.length, 1, 'a socket that answers pings should not be replaced')
  assert.equal(manager.status, 'connected')

  manager.close()
})

test('SocketManager heartbeat: no pong within the timeout drops the socket and reconnects at once', async () => {
  const { manager, instances } = makeManager(1000, { heartbeatIntervalMs: 10, heartbeatTimeoutMs: 10 })
  const sock = instances[0]
  sock.triggerOpen()

  await sleep(40)
  assert.ok(instances.length >= 2, 'a silent socket should have been replaced')
  assert.equal(instances[0], sock)
  assert.equal(manager.status, 'connecting', 'reconnect should not wait for the (1s) backoff')

  manager.close()
})

test('SocketManager heartbeat: pong messages are not delivered to handlers', () => {
  const { manager, instances } = makeManager()
  const sock = instances[0]
  sock.triggerOpen()
  const received: ServerMessage[] = []
  manager.onMessage((msg) => received.push(msg))

  sock.triggerMessage({ type: 'pong' })
  assert.deepEqual(received, [])

  manager.close()
})

// ---------------------------------------------------------------------------
// Test 5: reconnectNow — foreground/online wake-ups skip the backoff
// ---------------------------------------------------------------------------

test('SocketManager.reconnectNow: while waiting out a backoff, reconnects immediately', () => {
  const { manager, instances } = makeManager(10_000)
  instances[0].triggerOpen()
  instances[0].triggerClose()
  assert.equal(manager.status, 'disconnected')
  assert.equal(instances.length, 1)

  manager.reconnectNow()
  assert.equal(instances.length, 2, 'a new socket should be dialed without waiting')
  assert.equal(manager.status, 'connecting')

  manager.close()
})

test('SocketManager.reconnectNow: while connected, probes with a ping instead of reconnecting', () => {
  const { manager, instances } = makeManager(5, { heartbeatIntervalMs: 0, heartbeatTimeoutMs: 1000 })
  const sock = instances[0]
  sock.triggerOpen()

  manager.reconnectNow()
  assert.equal(instances.length, 1)
  assert.deepEqual(sentTypes(sock), ['ping'])

  manager.close()
})

test('SocketManager.reconnectNow: after close() does nothing', () => {
  const { manager, instances } = makeManager(10_000)
  instances[0].triggerOpen()
  instances[0].triggerClose()
  manager.close()

  manager.reconnectNow()
  assert.equal(instances.length, 1)
})

// ---------------------------------------------------------------------------
// Test 6: connect timeout — a dial that never opens is abandoned and retried
// ---------------------------------------------------------------------------

test('SocketManager connect timeout: a dial that never opens is abandoned and redialed', async () => {
  const { manager, instances } = makeManager(5, { connectTimeoutMs: 10 })
  assert.equal(instances.length, 1)
  assert.equal(manager.status, 'connecting')

  await sleep(60)
  assert.ok(instances.length >= 2, 'the hung dial should have been replaced')
  assert.equal(instances[0].readyState, CLOSED, 'the hung socket should have been closed')
  assert.equal(instances[0].onopen, null, 'the hung socket should be detached')

  // A late open on the abandoned socket must not be mistaken for success.
  instances[0].readyState = OPEN
  assert.notEqual(manager.status, 'connected')

  manager.close()
})

test('SocketManager connect timeout: cleared once the dial opens', async () => {
  const { manager, instances } = makeManager(5, { connectTimeoutMs: 10 })
  instances[0].triggerOpen()
  await sleep(40)
  assert.equal(instances.length, 1, 'an open socket must not be abandoned')
  assert.equal(manager.status, 'connected')

  manager.close()
})

test('SocketManager connect timeout: close() cancels a pending dial timer', async () => {
  const { manager, instances } = makeManager(5, { connectTimeoutMs: 10 })
  manager.close()
  await sleep(40)
  assert.equal(instances.length, 1)
})

// ---------------------------------------------------------------------------
// Test 7: reconnectNow mid-dial — an old hung dial is restarted, a fresh one kept
// ---------------------------------------------------------------------------

test('SocketManager.reconnectNow: mid-dial, restarts a dial that has hung for a while', () => {
  let clock = 0
  const { manager, instances } = makeManager(5, { connectTimeoutMs: 0, now: () => clock })
  assert.equal(manager.status, 'connecting')

  clock = 30_000
  manager.reconnectNow()
  assert.equal(instances.length, 2, 'a stale dial should be replaced')
  assert.equal(instances[0].readyState, CLOSED)
  assert.equal(manager.status, 'connecting')

  manager.close()
})

test('SocketManager.reconnectNow: mid-dial, leaves a fresh dial alone', () => {
  let clock = 0
  const { manager, instances } = makeManager(5, { connectTimeoutMs: 0, now: () => clock })

  clock = 200
  manager.reconnectNow()
  assert.equal(instances.length, 1, 'a dial made moments ago may be about to succeed')

  manager.close()
})

// ---------------------------------------------------------------------------
// Test 8: wake probe — coming back to the foreground judges the socket fast
// ---------------------------------------------------------------------------

test('SocketManager.reconnectNow: while connected, a dead socket is replaced within the wake timeout', async () => {
  const { manager, instances } = makeManager(1000, {
    heartbeatIntervalMs: 0, heartbeatTimeoutMs: 10_000, wakeProbeTimeoutMs: 10,
  })
  const sock = instances[0]
  sock.triggerOpen()

  manager.reconnectNow()
  assert.deepEqual(sentTypes(sock), ['ping'])
  await sleep(40)
  assert.equal(instances.length, 2, 'no pong within the wake timeout should replace the socket')
  assert.equal(manager.status, 'connecting', 'the redial should skip the backoff')

  manager.close()
})

test('SocketManager.reconnectNow: while connected, a pong keeps the socket', async () => {
  const { manager, instances } = makeManager(5, { heartbeatIntervalMs: 0, wakeProbeTimeoutMs: 10 })
  const sock = instances[0]
  sock.triggerOpen()

  manager.reconnectNow()
  sock.triggerMessage({ type: 'pong' })
  await sleep(40)
  assert.equal(instances.length, 1)
  assert.equal(manager.status, 'connected')

  manager.close()
})

test('SocketManager.reconnectNow: the wake probe shortens a pong deadline already running', async () => {
  const { manager, instances } = makeManager(5, {
    heartbeatIntervalMs: 0, heartbeatTimeoutMs: 10_000, wakeProbeTimeoutMs: 10,
  })
  const sock = instances[0]
  sock.triggerOpen()
  // A heartbeat ping is in flight with the long deadline...
  ;(manager as unknown as { ping(): void }).ping()
  assert.deepEqual(sentTypes(sock), ['ping'])

  // ...then the page wakes: the short deadline takes over.
  manager.reconnectNow()
  await sleep(40)
  assert.equal(instances.length, 2, 'the wake deadline should have replaced the socket')

  manager.close()
})

// ---------------------------------------------------------------------------
// Test 9: pause — a hidden page stops judging its socket
// ---------------------------------------------------------------------------

test('SocketManager.pause: stops the heartbeat and forgets a pending pong deadline', async () => {
  const { manager, instances } = makeManager(5, { heartbeatIntervalMs: 10, heartbeatTimeoutMs: 10 })
  const sock = instances[0]
  sock.triggerOpen()
  await sleep(15)
  assert.ok(sentTypes(sock).includes('ping'), 'the heartbeat should be running before the pause')

  manager.pause()
  const pingsAtPause = sock.sent.length
  await sleep(50)
  assert.equal(instances.length, 1, 'a paused manager must not condemn the socket')
  assert.equal(sock.sent.length, pingsAtPause, 'no pings while paused')
  assert.equal(manager.status, 'connected')

  manager.close()
})

test('SocketManager.pause: reconnectNow resumes the heartbeat', async () => {
  const { manager, instances } = makeManager(5, { heartbeatIntervalMs: 10, heartbeatTimeoutMs: 1000, wakeProbeTimeoutMs: 1000 })
  const sock = instances[0]
  sock.triggerOpen()
  manager.pause()
  sock.sent.length = 0

  manager.reconnectNow()
  assert.deepEqual(sentTypes(sock), ['ping'], 'the wake probe goes out at once')
  sock.triggerMessage({ type: 'pong' })
  await sleep(25)
  assert.ok(sock.sent.length >= 2, 'the heartbeat should tick again after the wake')

  manager.close()
})

test('SocketManager.pause: a socket that opens while paused does not start the heartbeat', async () => {
  const { manager, instances } = makeManager(5, { heartbeatIntervalMs: 10, heartbeatTimeoutMs: 10 })
  manager.pause()
  instances[0].triggerOpen()
  await sleep(50)
  assert.equal(instances.length, 1)
  assert.deepEqual(sentTypes(instances[0]), [])

  manager.close()
})
