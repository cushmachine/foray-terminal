// WebSocket connection manager for the Nest client.
//
// `SocketManager` is a framework-agnostic class that owns the actual
// connection lifecycle: connect, reconnect with exponential backoff,
// queue-until-open sends, an application-level heartbeat, and pub/sub for
// incoming messages. It has no dependency on React or the DOM (beyond the
// ambient `WebSocket` type used as its default factory), so it can be
// driven directly in tests with a mock socket.
//
// `useSocket()` is a thin React hook wrapping a SocketManager instance,
// exposing its status as component state and its send/onMessage methods
// as stable callbacks. It also nudges the manager whenever the page comes
// back to the foreground or the browser reports being online again, since
// phones drop sockets constantly and shouldn't have to wait out a backoff.

import { useCallback, useEffect, useRef, useState } from 'react'
import type { ClientMessage, ServerMessage } from '../shared/protocol'

export type SocketStatus = 'connecting' | 'connected' | 'disconnected'

export interface UseSocketReturn {
  status: SocketStatus
  send: (msg: ClientMessage) => void
  onMessage: (handler: (msg: ServerMessage) => void) => () => void
}

/**
 * The subset of the WebSocket API SocketManager needs. Matches both the
 * browser's WebSocket and Node's global WebSocket, and is easy to satisfy
 * with a mock in tests.
 */
export interface WebSocketLike {
  readyState: number
  send(data: string): void
  close(): void
  onopen: ((ev: unknown) => void) | null
  onclose: ((ev: unknown) => void) | null
  onerror: ((ev: unknown) => void) | null
  onmessage: ((ev: { data: unknown }) => void) | null
}

export type WebSocketFactory = (url: string) => WebSocketLike

const WS_OPEN = 1

/** Exponential backoff starting at 1s, doubling, capped at 10s. */
export function computeBackoffDelay(attempt: number): number {
  return Math.min(1000 * 2 ** attempt, 10000)
}

/** How often to probe the server while connected. */
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 25_000
/** How long to wait for a pong before declaring the socket dead. */
export const DEFAULT_HEARTBEAT_TIMEOUT_MS = 10_000

export interface SocketManagerOptions {
  /** Creates the underlying socket. Defaults to the global WebSocket. */
  factory?: WebSocketFactory
  /** Computes the reconnect delay (ms) for a given attempt count (0-based). */
  backoff?: (attempt: number) => number
  /** Ping cadence while connected. 0 disables the heartbeat. */
  heartbeatIntervalMs?: number
  /** Time allowed for a pong to arrive before the socket is dropped. */
  heartbeatTimeoutMs?: number
}

/**
 * Connect, reconnect-with-backoff, queue-until-open sends, heartbeat, and a
 * pub/sub for incoming messages — independent of React so it's directly
 * testable.
 */
export class SocketManager {
  status: SocketStatus = 'connecting'

  private ws: WebSocketLike | null = null
  private queue: ClientMessage[] = []
  private messageHandlers = new Set<(msg: ServerMessage) => void>()
  private statusHandlers = new Set<(status: SocketStatus) => void>()
  private reconnectAttempt = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  private pongTimer: ReturnType<typeof setTimeout> | null = null
  private closed = false

  private readonly url: string
  private readonly factory: WebSocketFactory
  private readonly backoff: (attempt: number) => number
  private readonly heartbeatIntervalMs: number
  private readonly heartbeatTimeoutMs: number

  constructor(url: string, options: SocketManagerOptions = {}) {
    this.url = url
    this.factory = options.factory ?? ((u) => new WebSocket(u) as unknown as WebSocketLike)
    this.backoff = options.backoff ?? computeBackoffDelay
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS
    this.heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? DEFAULT_HEARTBEAT_TIMEOUT_MS
    this.connect()
  }

  private setStatus(status: SocketStatus): void {
    if (this.status === status) return
    this.status = status
    for (const handler of this.statusHandlers) handler(status)
  }

  private connect(): void {
    if (this.closed) return
    this.setStatus('connecting')

    const ws = this.factory(this.url)
    this.ws = ws

    ws.onopen = () => {
      this.reconnectAttempt = 0
      this.setStatus('connected')
      this.startHeartbeat()
      const pending = this.queue
      this.queue = []
      for (const msg of pending) {
        ws.send(JSON.stringify(msg))
      }
    }

    ws.onmessage = (ev) => {
      let msg: ServerMessage
      try {
        msg = JSON.parse(String(ev.data)) as ServerMessage
      } catch {
        return
      }
      // Any traffic proves the connection is alive, not just the pong.
      this.clearPongTimer()
      if (msg.type === 'pong') return
      for (const handler of this.messageHandlers) handler(msg)
    }

    ws.onclose = () => {
      if (this.ws !== ws) return // stale handler from a socket we've since replaced
      this.stopHeartbeat()
      this.setStatus('disconnected')
      this.scheduleReconnect()
    }

    ws.onerror = () => {
      // 'close' follows 'error' on a real WebSocket — reconnect is handled there.
    }
  }

  private scheduleReconnect(): void {
    if (this.closed) return
    const delay = this.backoff(this.reconnectAttempt)
    this.reconnectAttempt += 1
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.connect()
    }, delay)
  }

  // -- heartbeat ------------------------------------------------------------

  private startHeartbeat(): void {
    this.stopHeartbeat()
    if (this.heartbeatIntervalMs <= 0) return
    this.heartbeatTimer = setInterval(() => this.ping(), this.heartbeatIntervalMs)
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
    this.heartbeatTimer = null
    this.clearPongTimer()
  }

  private clearPongTimer(): void {
    if (this.pongTimer) clearTimeout(this.pongTimer)
    this.pongTimer = null
  }

  /**
   * Send a ping and start the pong countdown. A ping already in flight is
   * left alone: its timer will decide the socket's fate.
   */
  private ping(): void {
    if (!this.ws || this.ws.readyState !== WS_OPEN || this.pongTimer) return
    // Arm the timer before sending so an instant reply can't slip in ahead
    // of it and leave it running.
    this.pongTimer = setTimeout(() => {
      this.pongTimer = null
      this.dropDeadConnection()
    }, this.heartbeatTimeoutMs)
    this.ws.send(JSON.stringify({ type: 'ping' } satisfies ClientMessage))
  }

  /**
   * The socket looks open but nothing comes back. Closing it normally would
   * wait on a close handshake the far end will never answer, so detach from
   * it, mark ourselves disconnected, and dial again right away.
   */
  private dropDeadConnection(): void {
    const ws = this.ws
    this.ws = null
    this.stopHeartbeat()
    if (ws) {
      ws.onopen = ws.onclose = ws.onerror = ws.onmessage = null
      try {
        ws.close()
      } catch {
        // A socket that is already gone can throw here; nothing to do.
      }
    }
    this.setStatus('disconnected')
    this.reconnectAttempt = 0
    this.connect()
  }

  /**
   * Called when the page regains focus or the network comes back. Skips any
   * pending backoff and reconnects now; if we believe we're connected, probes
   * the server so a silently dead socket is found within the pong timeout
   * instead of the next heartbeat tick.
   */
  reconnectNow(): void {
    if (this.closed) return
    if (this.status === 'connected') {
      this.ping()
      return
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
      this.reconnectAttempt = 0
      this.connect()
    }
  }

  /** Sends immediately if open, otherwise queues until the connection opens. */
  send(msg: ClientMessage): void {
    if (this.ws && this.ws.readyState === WS_OPEN) {
      this.ws.send(JSON.stringify(msg))
    } else {
      this.queue.push(msg)
    }
  }

  /** Registers a handler for incoming server messages. Returns an unsubscribe function. */
  onMessage(handler: (msg: ServerMessage) => void): () => void {
    this.messageHandlers.add(handler)
    return () => this.messageHandlers.delete(handler)
  }

  /** Registers a handler for connection status changes. Returns an unsubscribe function. */
  onStatusChange(handler: (status: SocketStatus) => void): () => void {
    this.statusHandlers.add(handler)
    return () => this.statusHandlers.delete(handler)
  }

  /** Closes the connection and stops any further reconnect attempts. */
  close(): void {
    this.closed = true
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.stopHeartbeat()
    this.messageHandlers.clear()
    this.statusHandlers.clear()
    this.ws?.close()
  }
}

function socketUrl(): string {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${protocol}//${window.location.host}/ws`
}

/** Connects to the Nest WebSocket server and exposes status + send/receive. */
export function useSocket(): UseSocketReturn {
  const managerRef = useRef<SocketManager | null>(null)
  const [status, setStatus] = useState<SocketStatus>('connecting')

  useEffect(() => {
    const manager = new SocketManager(socketUrl())
    managerRef.current = manager
    setStatus(manager.status)
    const unsubscribe = manager.onStatusChange(setStatus)

    // Mobile browsers freeze timers and drop sockets when the app is in the
    // background. The moment we're visible or online again, reconnect
    // instead of waiting out whatever backoff was scheduled.
    const wake = () => {
      if (document.visibilityState === 'hidden') return
      manager.reconnectNow()
    }
    document.addEventListener('visibilitychange', wake)
    window.addEventListener('online', wake)
    window.addEventListener('pageshow', wake)

    return () => {
      document.removeEventListener('visibilitychange', wake)
      window.removeEventListener('online', wake)
      window.removeEventListener('pageshow', wake)
      unsubscribe()
      manager.close()
      managerRef.current = null
    }
  }, [])

  const send = useCallback((msg: ClientMessage) => {
    managerRef.current?.send(msg)
  }, [])

  const onMessage = useCallback((handler: (msg: ServerMessage) => void) => {
    const manager = managerRef.current
    if (!manager) return () => {}
    return manager.onMessage(handler)
  }, [])

  return { status, send, onMessage }
}
