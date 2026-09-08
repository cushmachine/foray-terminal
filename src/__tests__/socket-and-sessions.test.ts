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

import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'

import {
  SocketManager,
  computeBackoffDelay,
  type SocketManagerOptions,
  type WebSocketLike,
} from '../hooks/useSocket.ts'
import {
  activeAfterList,
  applySessionMessage,
  displayName,
  nextActiveAfterKill,
  pendingCreateAfter,
  reduceSessions,
  type Session,
} from '../sessionState.ts'
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

/**
 * Put the manager's timers (backoff, heartbeat, pong and dial deadlines)
 * under the test's control: `t.mock.timers.tick(ms)` then fires exactly
 * what `ms` of wall time would, with no waiting. Restored when the test
 * ends.
 */
function fakeTimers(t: TestContext): void {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
}

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

test('SocketManager: transitions to disconnected on close and schedules a reconnect', (t) => {
  fakeTimers(t)
  const { manager, instances } = makeManager(5)
  instances[0].triggerOpen()
  assert.equal(manager.status, 'connected')

  instances[0].triggerClose()
  assert.equal(manager.status, 'disconnected')
  assert.equal(instances.length, 1, 'reconnect should be scheduled, not immediate')

  t.mock.timers.tick(4)
  assert.equal(instances.length, 1, 'not before the (mocked, 5ms) backoff has elapsed')
  t.mock.timers.tick(1)
  assert.equal(instances.length, 2, 'a new socket should have been created for the reconnect')
  assert.equal(manager.status, 'connecting')

  manager.close()
})

test('SocketManager: close() stops further reconnect attempts', (t) => {
  fakeTimers(t)
  const { manager, instances } = makeManager(5)
  instances[0].triggerOpen()
  instances[0].triggerClose()

  manager.close()
  t.mock.timers.tick(40)

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
// Test 2b: which session is active
// ---------------------------------------------------------------------------

function session(id: number): Session {
  return { id, name: `s${id}`, cwd: '/root', title: '', command: 'bash', named: false }
}

const THREE = [session(1), session(2), session(3)]

test('activeAfterList: keeps a choice that still exists', () => {
  assert.equal(activeAfterList(THREE, 2, '3'), 2)
})

test('activeAfterList: reopens the stored session on the first list, else the first listed', () => {
  assert.equal(activeAfterList(THREE, null, '3'), 3)
  assert.equal(activeAfterList(THREE, null, '9'), 1)
  assert.equal(activeAfterList(THREE, null, 'garbage'), 1)
  assert.equal(activeAfterList(THREE, null, null), 1)
  assert.equal(activeAfterList([], null, '1'), null)
})

test('activeAfterList: an active session missing from the list falls back the same way', () => {
  assert.equal(activeAfterList(THREE, 7, '2'), 2)
  assert.equal(activeAfterList(THREE, 7, null), 1)
})

test('nextActiveAfterKill: killing another session leaves the active one alone', () => {
  assert.equal(nextActiveAfterKill(THREE, 2, 3), 2)
  assert.equal(nextActiveAfterKill(THREE, null, 3), null)
})

test('nextActiveAfterKill: killing the active session moves to a neighbour in creation order', () => {
  assert.equal(nextActiveAfterKill(THREE, 2, 2), 3, 'the next newer session')
  assert.equal(nextActiveAfterKill(THREE, 3, 3), 2, 'the newest older one when nothing is newer')
  assert.equal(nextActiveAfterKill([session(3), session(1), session(2)], 1, 1), 2, 'creation order, not list order')
})

test('nextActiveAfterKill: killing the last session leaves nothing active', () => {
  assert.equal(nextActiveAfterKill([session(1)], 1, 1), null)
})

// The create flag: only the device that asked for a session switches to
// it. If the create fails the flag must clear, or the next session anyone
// else creates would yank this device into it.

test('pendingCreateAfter: clears when the session arrives and on an error answering session:create', () => {
  assert.equal(pendingCreateAfter(true, { type: 'session:created', window: WIN_B }), false)
  const failed = { type: 'error', message: 'tmux said no', request: 'session:create' } as ServerMessage
  assert.equal(pendingCreateAfter(true, failed), false)
  assert.equal(pendingCreateAfter(false, { type: 'session:created', window: WIN_B }), false)
})

test('pendingCreateAfter: survives unrelated messages and errors for other requests', () => {
  assert.equal(pendingCreateAfter(true, { type: 'session:renamed', windowId: 1, name: 'x' }), true)
  assert.equal(pendingCreateAfter(true, { type: 'terminal:output', windowId: 0, data: 'hi' }), true)
  const other = { type: 'error', message: 'no such file', request: 'files:read' } as ServerMessage
  assert.equal(pendingCreateAfter(true, other), true)
})

test('reduceSessions: a list picks the active session; select changes it', () => {
  const listed = reduceSessions({ sessions: [], active: null }, {
    type: 'message', msg: { type: 'session:list', windows: THREE }, own: false, savedRaw: '2',
  })
  assert.deepEqual(listed, { sessions: THREE, active: 2 })
  const selected = reduceSessions(listed, { type: 'select', id: 3 })
  assert.equal(selected.active, 3)
  assert.equal(reduceSessions(selected, { type: 'select', id: 3 }), selected, 'no change, same reference')
})

test('reduceSessions: killing the active session picks a replacement in the same step', () => {
  const next = reduceSessions({ sessions: THREE, active: 2 }, {
    type: 'message', msg: { type: 'session:killed', windowId: 2 }, own: false, savedRaw: null,
  })
  assert.deepEqual(next.sessions.map((s) => s.id), [1, 3])
  assert.equal(next.active, 3)
})

test('reduceSessions: only the client that asked for a session switches to it', () => {
  const state = { sessions: [session(1)], active: 1 }
  const msg: ServerMessage = { type: 'session:created', window: session(2) }
  assert.equal(reduceSessions(state, { type: 'message', msg, own: false, savedRaw: null }).active, 1)
  assert.equal(reduceSessions(state, { type: 'message', msg, own: true, savedRaw: null }).active, 2)
})

test('reduceSessions: unrelated messages return the same state', () => {
  const state = { sessions: THREE, active: 1 }
  const msg: ServerMessage = { type: 'terminal:output', windowId: 1, data: 'x' }
  assert.equal(reduceSessions(state, { type: 'message', msg, own: false, savedRaw: null }), state)
})

// ---------------------------------------------------------------------------
// Test 3: send() queues while disconnected, flushes on open
// ---------------------------------------------------------------------------

test('SocketManager.send: queues messages while disconnected, flushes in order on open', () => {
  const { manager, instances } = makeManager()
  const sock = instances[0]

  assert.equal(manager.send({ type: 'client:hello', build: 'abc' }), true)
  assert.equal(manager.send({ type: 'session:kill', windowId: 0 }), true)

  assert.deepEqual(sock.sent, [], 'nothing should be sent before the socket opens')

  sock.triggerOpen()

  assert.equal(sock.sent.length, 2)
  assert.deepEqual(JSON.parse(sock.sent[0]), { type: 'client:hello', build: 'abc' })
  assert.deepEqual(JSON.parse(sock.sent[1]), { type: 'session:kill', windowId: 0 })

  manager.close()
})

// A terminal message sent while the socket is down is stale by the time
// the socket is back: every terminal re-attaches on connect, and a
// replayed attach or resize from before the drop would produce a second
// pty or a resize for a size that is gone.
test('SocketManager.send: terminal:* sent while closed is refused and not replayed; client:hello still queues', () => {
  const { manager, instances } = makeManager()
  const sock = instances[0]

  assert.equal(manager.send({ type: 'terminal:attach', windowId: 0, cols: 80, rows: 24 }), false)
  assert.equal(manager.send({ type: 'client:hello', build: 'abc' }), true)

  sock.triggerOpen()
  assert.deepEqual(sentTypes(sock), ['client:hello'], 'only the hello is replayed on open')

  assert.equal(manager.send({ type: 'terminal:input', windowId: 0, data: 'x' }), true)
  assert.deepEqual(sentTypes(sock), ['client:hello', 'terminal:input'])

  manager.close()
})

test('SocketManager.send: after close() nothing is queued', () => {
  const { manager } = makeManager()
  manager.close()
  assert.equal(manager.send({ type: 'client:hello', build: 'abc' }), false)
})

test('SocketManager.send: sends immediately once connected', () => {
  const { manager, instances } = makeManager()
  const sock = instances[0]
  sock.triggerOpen()

  assert.equal(manager.send({ type: 'session:create' }), true)

  assert.equal(sock.sent.length, 1)
  assert.deepEqual(JSON.parse(sock.sent[0]), { type: 'session:create' })

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

test('SocketManager heartbeat: sends ping on the interval once connected', (t) => {
  fakeTimers(t)
  const { manager, instances } = makeManager(5, { heartbeatIntervalMs: 10, heartbeatTimeoutMs: 1000 })
  const sock = instances[0]
  sock.triggerOpen()

  t.mock.timers.tick(9)
  assert.deepEqual(sentTypes(sock), [], 'nothing before the first interval')
  t.mock.timers.tick(1)
  assert.deepEqual(sentTypes(sock), ['ping'], 'a ping should have gone out')

  manager.close()
})

test('SocketManager heartbeat: a pong keeps the connection alive', (t) => {
  fakeTimers(t)
  const { manager, instances } = makeManager(5, { heartbeatIntervalMs: 10, heartbeatTimeoutMs: 15 })
  const sock = instances[0]
  sock.triggerOpen()
  // Behave like a healthy server: answer every ping.
  const origSend = sock.send.bind(sock)
  sock.send = (data: string) => {
    origSend(data)
    if (JSON.parse(data).type === 'ping') sock.triggerMessage({ type: 'pong' })
  }

  t.mock.timers.tick(60)
  assert.equal(sentTypes(sock).filter((type) => type === 'ping').length, 6, 'one ping per interval')
  assert.equal(instances.length, 1, 'a socket that answers pings should not be replaced')
  assert.equal(manager.status, 'connected')

  manager.close()
})

test('SocketManager heartbeat: no pong within the timeout drops the socket and reconnects at once', (t) => {
  fakeTimers(t)
  const { manager, instances } = makeManager(1000, { heartbeatIntervalMs: 10, heartbeatTimeoutMs: 10 })
  const sock = instances[0]
  sock.triggerOpen()

  t.mock.timers.tick(10)
  assert.deepEqual(sentTypes(sock), ['ping'])
  t.mock.timers.tick(9)
  assert.equal(instances.length, 1, 'the pong deadline has not passed yet')
  t.mock.timers.tick(1)
  assert.equal(instances.length, 2, 'a silent socket should have been replaced')
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

test('SocketManager connect timeout: a dial that never opens is abandoned and redialed', (t) => {
  fakeTimers(t)
  const { manager, instances } = makeManager(5, { connectTimeoutMs: 10 })
  assert.equal(instances.length, 1)
  assert.equal(manager.status, 'connecting')

  t.mock.timers.tick(10)
  assert.equal(manager.status, 'disconnected', 'the hung dial is abandoned at the deadline')
  t.mock.timers.tick(5)
  assert.equal(instances.length, 2, 'the hung dial should have been replaced after the backoff')
  assert.equal(instances[0].readyState, CLOSED, 'the hung socket should have been closed')
  assert.equal(instances[0].onopen, null, 'the hung socket should be detached')

  // A late open on the abandoned socket must not be mistaken for success.
  instances[0].readyState = OPEN
  assert.notEqual(manager.status, 'connected')

  manager.close()
})

test('SocketManager connect timeout: cleared once the dial opens', (t) => {
  fakeTimers(t)
  const { manager, instances } = makeManager(5, { connectTimeoutMs: 10 })
  instances[0].triggerOpen()
  t.mock.timers.tick(40)
  assert.equal(instances.length, 1, 'an open socket must not be abandoned')
  assert.equal(manager.status, 'connected')

  manager.close()
})

test('SocketManager connect timeout: close() cancels a pending dial timer', (t) => {
  fakeTimers(t)
  const { manager, instances } = makeManager(5, { connectTimeoutMs: 10 })
  manager.close()
  t.mock.timers.tick(40)
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

test('SocketManager.reconnectNow: while connected, a dead socket is replaced within the wake timeout', (t) => {
  fakeTimers(t)
  const { manager, instances } = makeManager(1000, {
    heartbeatIntervalMs: 0, heartbeatTimeoutMs: 10_000, wakeProbeTimeoutMs: 10,
  })
  const sock = instances[0]
  sock.triggerOpen()

  manager.reconnectNow()
  assert.deepEqual(sentTypes(sock), ['ping'])
  t.mock.timers.tick(10)
  assert.equal(instances.length, 2, 'no pong within the wake timeout should replace the socket')
  assert.equal(manager.status, 'connecting', 'the redial should skip the backoff')

  manager.close()
})

test('SocketManager.reconnectNow: while connected, a pong keeps the socket', (t) => {
  fakeTimers(t)
  const { manager, instances } = makeManager(5, { heartbeatIntervalMs: 0, wakeProbeTimeoutMs: 10 })
  const sock = instances[0]
  sock.triggerOpen()

  manager.reconnectNow()
  sock.triggerMessage({ type: 'pong' })
  t.mock.timers.tick(40)
  assert.equal(instances.length, 1)
  assert.equal(manager.status, 'connected')

  manager.close()
})

test('SocketManager.reconnectNow: the wake probe shortens a pong deadline already running', (t) => {
  fakeTimers(t)
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
  t.mock.timers.tick(10)
  assert.equal(instances.length, 2, 'the wake deadline should have replaced the socket')

  manager.close()
})

// ---------------------------------------------------------------------------
// Test 9: pause — a hidden page stops judging its socket
// ---------------------------------------------------------------------------

test('SocketManager.pause: stops the heartbeat and forgets a pending pong deadline', (t) => {
  fakeTimers(t)
  const { manager, instances } = makeManager(5, { heartbeatIntervalMs: 10, heartbeatTimeoutMs: 10 })
  const sock = instances[0]
  sock.triggerOpen()
  t.mock.timers.tick(10)
  assert.deepEqual(sentTypes(sock), ['ping'], 'the heartbeat should be running before the pause')

  // Paused with that ping's pong deadline still open.
  manager.pause()
  const pingsAtPause = sock.sent.length
  t.mock.timers.tick(50)
  assert.equal(instances.length, 1, 'a paused manager must not condemn the socket')
  assert.equal(sock.sent.length, pingsAtPause, 'no pings while paused')
  assert.equal(manager.status, 'connected')

  manager.close()
})

test('SocketManager.pause: reconnectNow resumes the heartbeat', (t) => {
  fakeTimers(t)
  const { manager, instances } = makeManager(5, { heartbeatIntervalMs: 10, heartbeatTimeoutMs: 1000, wakeProbeTimeoutMs: 1000 })
  const sock = instances[0]
  sock.triggerOpen()
  manager.pause()
  sock.sent.length = 0

  manager.reconnectNow()
  assert.deepEqual(sentTypes(sock), ['ping'], 'the wake probe goes out at once')
  sock.triggerMessage({ type: 'pong' })
  t.mock.timers.tick(10)
  assert.deepEqual(sentTypes(sock), ['ping', 'ping'], 'the heartbeat should tick again after the wake')

  manager.close()
})

test('SocketManager.pause: a socket that opens while paused does not start the heartbeat', (t) => {
  fakeTimers(t)
  const { manager, instances } = makeManager(5, { heartbeatIntervalMs: 10, heartbeatTimeoutMs: 10 })
  manager.pause()
  instances[0].triggerOpen()
  t.mock.timers.tick(50)
  assert.equal(instances.length, 1)
  assert.deepEqual(sentTypes(instances[0]), [])

  manager.close()
})
