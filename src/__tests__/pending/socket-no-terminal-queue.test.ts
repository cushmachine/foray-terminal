// Pending for S5 (SocketManager.send returns boolean; terminal:* is never queued).
//
// A terminal message sent while the socket is down is stale by the time
// the socket is back: every terminal re-attaches on connect, and replaying
// a queued attach or resize from before the drop produces a second pty or
// a resize for a size that is gone. So terminal:* is dropped (send returns
// false) while client:hello and session ops still queue for the open.
// Today send returns nothing and queues everything.
//
// Run with: npx tsx --test src/__tests__/pending/socket-no-terminal-queue.test.ts

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SocketManager, type WebSocketLike } from '../../hooks/useSocket.ts'

const OPEN = 1

class MockSocket implements WebSocketLike {
  readyState = 0
  sent: string[] = []
  onopen: ((ev: unknown) => void) | null = null
  onclose: ((ev: unknown) => void) | null = null
  onerror: ((ev: unknown) => void) | null = null
  onmessage: ((ev: { data: unknown }) => void) | null = null

  send(data: string): void {
    this.sent.push(data)
  }

  close(): void {
    this.readyState = 3
  }

  open(): void {
    this.readyState = OPEN
    this.onopen?.({})
  }
}

test('terminal:* sent while closed is refused and not replayed; client:hello still queues', () => {
  let socket!: MockSocket
  const manager = new SocketManager('ws://test', {
    factory: () => {
      socket = new MockSocket()
      return socket
    },
    heartbeatIntervalMs: 0,
    connectTimeoutMs: 0,
  })
  try {
    // Still dialling: nothing is open yet.
    const attach: unknown = manager.send({ type: 'terminal:attach', windowId: 0, cols: 80, rows: 24 })
    const hello: unknown = manager.send({ type: 'client:hello', build: 'abc' })
    assert.equal(attach, false, 'a terminal message has no home while the socket is closed')
    assert.equal(hello, true, 'client:hello is queued for the open')

    socket.open()
    const types = socket.sent.map((raw) => (JSON.parse(raw) as { type: string }).type)
    assert.deepEqual(types, ['client:hello'], 'only the hello is replayed on open')

    const live: unknown = manager.send({ type: 'terminal:input', windowId: 0, data: 'x' })
    assert.equal(live, true, 'an open socket sends terminal messages')
  } finally {
    manager.close()
  }
})
