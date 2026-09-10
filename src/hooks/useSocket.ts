// WebSocket connection manager for the Foray client.
//
// `SocketManager` is a framework-agnostic class that owns the actual
// connection lifecycle: connect, reconnect with exponential backoff,
// queue-until-open sends (except terminal traffic, see `send`), an
// application-level heartbeat, and pub/sub for incoming messages. It has no dependency on React or the DOM (beyond the
// ambient `WebSocket` type used as its default factory), so it can be
// driven directly in tests with a mock socket.
//
// `useSocket()` is a thin React hook wrapping a SocketManager instance,
// exposing its status as component state and its send/onMessage methods
// as stable callbacks. It also pauses the heartbeat while the page is
// hidden and nudges the manager whenever the page comes back to the
// foreground or the browser reports being online again, since phones drop
// sockets constantly and shouldn't have to wait out a backoff.

import { useCallback, useEffect, useState } from 'react'
import type { ClientMessage, ServerMessage } from '../shared/protocol'

export type SocketStatus = 'connecting' | 'connected' | 'disconnected'

export interface UseSocketReturn {
  status: SocketStatus
  /** See SocketManager.send: false means the message was dropped. */
  send: (msg: ClientMessage) => boolean
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
/**
 * How long a dial may sit without opening before it is abandoned and tried
 * again. A phone waking from sleep often dials before its VPN or radio is
 * back; those packets go nowhere and the OS would take minutes to notice.
 */
export const DEFAULT_CONNECT_TIMEOUT_MS = 5_000
/**
 * Pong deadline for the probe sent when the page returns to the foreground.
 * A socket that died in the background should be found and replaced in a
 * moment, not after the full heartbeat timeout.
 */
export const DEFAULT_WAKE_PROBE_TIMEOUT_MS = 2_000
/**
 * A dial younger than this is left alone by reconnectNow(): the wake events
 * (visibilitychange, pageshow, online) tend to arrive together, and a fresh
 * dial may well be about to succeed.
 */
export const WAKE_REDIAL_MIN_AGE_MS = 1_000

export interface SocketManagerOptions {
  /** Creates the underlying socket. Defaults to the global WebSocket. */
  factory?: WebSocketFactory
  /** Computes the reconnect delay (ms) for a given attempt count (0-based). */
  backoff?: (attempt: number) => number
  /** Ping cadence while connected. 0 disables the heartbeat. */
  heartbeatIntervalMs?: number
  /** Time allowed for a pong to arrive before the socket is dropped. */
  heartbeatTimeoutMs?: number
  /** Time allowed for a dial to open before it is abandoned. 0 disables. */
  connectTimeoutMs?: number
  /** Pong deadline for the foreground probe (see reconnectNow). */
  wakeProbeTimeoutMs?: number
  /** Clock used to age dials; tests inject a fake. */
  now?: () => number
  /** Dial in the constructor (the default), or wait for open(). */
  autoConnect?: boolean
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
  private connectTimer: ReturnType<typeof setTimeout> | null = null
  /** When the current dial started; meaningful only while `connecting`. */
  private dialStartedAt = 0
  private paused = false
  private closed = false
  private opened = false

  private readonly url: string
  private readonly factory: WebSocketFactory
  private readonly backoff: (attempt: number) => number
  private readonly heartbeatIntervalMs: number
  private readonly heartbeatTimeoutMs: number
  private readonly connectTimeoutMs: number
  private readonly wakeProbeTimeoutMs: number
  private readonly now: () => number

  constructor(url: string, options: SocketManagerOptions = {}) {
    this.url = url
    this.factory = options.factory ?? ((u) => new WebSocket(u) as unknown as WebSocketLike)
    this.backoff = options.backoff ?? computeBackoffDelay
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS
    this.heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? DEFAULT_HEARTBEAT_TIMEOUT_MS
    this.connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS
    this.wakeProbeTimeoutMs = options.wakeProbeTimeoutMs ?? DEFAULT_WAKE_PROBE_TIMEOUT_MS
    this.now = options.now ?? (() => Date.now())
    if (options.autoConnect ?? true) this.open()
  }

  /** Start dialling. Once: later calls, and any call after close(), do nothing. */
  open(): void {
    if (this.opened || this.closed) return
    this.opened = true
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
    this.dialStartedAt = this.now()
    this.clearConnectTimer()
    if (this.connectTimeoutMs > 0) {
      this.connectTimer = setTimeout(() => {
        this.connectTimer = null
        this.abandonDial()
      }, this.connectTimeoutMs)
    }

    ws.onopen = () => {
      this.clearConnectTimer()
      this.reconnectAttempt = 0
      this.setStatus('connected')
      if (!this.paused) this.startHeartbeat()
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
      this.clearConnectTimer()
      this.stopHeartbeat()
      this.setStatus('disconnected')
      this.scheduleReconnect()
    }

    ws.onerror = () => {
      // 'close' follows 'error' on a real WebSocket — reconnect is handled there.
    }
  }

  /** Earliest time the next dial may start; set by dropForTest. */
  private holdUntil = 0

  /**
   * Test hook: lose the socket the way a sleeping phone does, and hold the
   * reconnect off for `holdMs` so a test can change the pane meanwhile.
   */
  dropForTest(holdMs = 0): void {
    this.holdUntil = this.now() + holdMs
    this.ws?.close()
  }

  private scheduleReconnect(): void {
    if (this.closed) return
    const delay = Math.max(this.backoff(this.reconnectAttempt), this.holdUntil - this.now())
    this.reconnectAttempt += 1
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.connect()
    }, delay)
  }

  private clearConnectTimer(): void {
    if (this.connectTimer) clearTimeout(this.connectTimer)
    this.connectTimer = null
  }

  /**
   * Drop the current socket without waiting on a close handshake the far
   * end may never answer: its handlers are removed first, so its close
   * event never reaches scheduleReconnect.
   */
  private detach(): void {
    const ws = this.ws
    this.ws = null
    this.clearConnectTimer()
    this.stopHeartbeat()
    if (!ws) return
    ws.onopen = ws.onclose = ws.onerror = ws.onmessage = null
    try {
      ws.close()
    } catch {
      // A socket that is already gone can throw here; nothing to do.
    }
  }

  /**
   * The dial has not opened in time. Drop it and try again on the backoff
   * schedule; the far end may simply not be reachable yet.
   */
  private abandonDial(): void {
    this.detach()
    this.setStatus('disconnected')
    this.scheduleReconnect()
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
    if (this.pongTimer) return
    this.probe(this.heartbeatTimeoutMs)
  }

  /**
   * Send a ping and give the server `timeoutMs` to answer, replacing any
   * pong deadline already running. Used by the heartbeat and, with a much
   * shorter deadline, by the foreground wake-up.
   */
  private probe(timeoutMs: number): void {
    if (!this.ws || this.ws.readyState !== WS_OPEN) return
    this.clearPongTimer()
    // Arm the timer before sending so an instant reply can't slip in ahead
    // of it and leave it running.
    this.pongTimer = setTimeout(() => {
      this.pongTimer = null
      this.dropDeadConnection()
    }, timeoutMs)
    this.ws.send(JSON.stringify({ type: 'ping' } satisfies ClientMessage))
  }

  /**
   * The socket looks open but nothing comes back. Closing it normally would
   * wait on a close handshake the far end will never answer, so detach from
   * it, mark ourselves disconnected, and dial again right away.
   */
  private dropDeadConnection(): void {
    this.detach()
    this.setStatus('disconnected')
    this.reconnectAttempt = 0
    this.connect()
  }

  /**
   * The page went to the background. Stop judging the socket: timers are
   * frozen there and would all fire at once on return, condemning a socket
   * that may be fine. The server's protocol-level pings keep it alive
   * meanwhile. reconnectNow() resumes the heartbeat.
   */
  pause(): void {
    this.paused = true
    this.stopHeartbeat()
  }

  /**
   * Called when the page regains focus or the network comes back. Skips any
   * pending backoff and reconnects now; if we believe we're connected, probes
   * the server so a silently dead socket is found within the pong timeout
   * instead of the next heartbeat tick.
   */
  reconnectNow(): void {
    if (this.closed) return
    this.paused = false
    if (this.status === 'connected') {
      this.startHeartbeat()
      this.probe(this.wakeProbeTimeoutMs)
      return
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
      this.reconnectAttempt = 0
      this.connect()
      return
    }
    // Mid-dial. A dial that has been hanging for a while was probably made
    // before the network was back; start over rather than wait it out.
    if (this.ws && this.now() - this.dialStartedAt >= WAKE_REDIAL_MIN_AGE_MS) {
      this.detach()
      this.reconnectAttempt = 0
      this.connect()
    }
  }

  /**
   * Sends immediately if open, otherwise queues until the connection opens.
   * Returns false if the message was dropped instead.
   *
   * Terminal traffic is never queued: every terminal re-attaches when the
   * socket comes back, so an attach, resize or keystroke from before the
   * drop replayed on the new socket would spawn a second pty, resize it to
   * a size that is gone, or type into the wrong moment. The hello and the
   * session ops are still worth delivering late.
   */
  send(msg: ClientMessage): boolean {
    if (this.ws && this.ws.readyState === WS_OPEN) {
      this.ws.send(JSON.stringify(msg))
      return true
    }
    if (this.closed || msg.type.startsWith('terminal:')) return false
    this.queue.push(msg)
    return true
  }

  /** True once close() has been called; the manager never dials again. */
  get isClosed(): boolean {
    return this.closed
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
    this.clearConnectTimer()
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

/**
 * Connects to the Foray WebSocket server and exposes status + send/receive.
 *
 * The manager is created during the first render, not in an effect, so a
 * child's `onMessage` subscription in its own (earlier-running) effect
 * lands on a live manager. It does not dial until the effect opens it:
 * strict mode runs the initializer twice and keeps one manager, and the
 * other must not be left holding a socket. The effect also wires the wake
 * listeners and closes the manager on unmount; a manager found closed on
 * re-run (the strict-mode double mount) is replaced.
 */
export function useSocket(): UseSocketReturn {
  const [manager, setManager] = useState(() => new SocketManager(socketUrl(), { autoConnect: false }))
  const [status, setStatus] = useState<SocketStatus>(manager.status)

  useEffect(() => {
    if (manager.isClosed) {
      setManager(new SocketManager(socketUrl(), { autoConnect: false }))
      return
    }
    manager.open()
    // Test hook (see SocketManager.dropForTest).
    const w = window as unknown as { __nestSocket?: { drop: (holdMs?: number) => void } }
    w.__nestSocket = { drop: (holdMs) => manager.dropForTest(holdMs) }
    setStatus(manager.status)
    const unsubscribe = manager.onStatusChange(setStatus)

    // Mobile browsers freeze timers and drop sockets when the app is in the
    // background. The moment we're visible or online again, reconnect
    // instead of waiting out whatever backoff was scheduled.
    const wake = () => {
      if (document.visibilityState === 'hidden') {
        manager.pause()
        return
      }
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
      delete w.__nestSocket
    }
  }, [manager])

  const send = useCallback((msg: ClientMessage) => manager.send(msg), [manager])
  const onMessage = useCallback(
    (handler: (msg: ServerMessage) => void) => manager.onMessage(handler),
    [manager],
  )

  return { status, send, onMessage }
}
