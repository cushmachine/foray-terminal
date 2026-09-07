// Per-connection WebSocket handler for Nest.
//
// Owns the pty handles, history trackers, file panel state, and message
// dispatch for a single client connection.  Extracted from index.ts to
// keep server setup and per-connection logic in separate files.

import path from 'node:path'
import type { WebSocket } from 'ws'
import { MAX_HISTORY_LINES, type ClientMessage, type ServerMessage } from '../shared/protocol.ts'
import { listWindows, createWindow, killWindow, renameWindow, paneHistoryState, captureHistoryLines } from './tmux.ts'
import { planHistoryUpdate, alignHistory, nextTail } from './history.ts'
import { attachToPane, type PtyHandle, type PtySpawner } from './pty-bridge.ts'
import { getTree, readFile, writeFile, watchDir, type Watcher } from './files.ts'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Scrollback comes from tmux's history, not from the byte stream (see
 * history.ts). Once pty output has been quiet for this long the server asks
 * tmux whether the history grew and ships the new lines, so a burst costs
 * one tmux call rather than one per chunk.
 */
const HISTORY_CHECK_MS = 80

/**
 * Lines remembered from what was last sent. At the history limit the size
 * stops moving while lines rotate through, so new lines are found by
 * overlap with these.
 */
const HISTORY_TAIL = 50

/**
 * How long after a resize to wait before sending the whole history again.
 * tmux reflows history to the new width, which moves the line boundaries
 * the client already has.
 */
const HISTORY_REFLOW_MS = 150

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** What one connection has told a client about one window's history. */
interface HistoryTracker {
  /** History size the client has; null when nothing has been sent. */
  known: number | null
  /** Last HISTORY_TAIL lines sent, for alignment. */
  sentTail: string[]
  timer: ReturnType<typeof setTimeout> | null
  running: boolean
  /** Output arrived while a sync was running, so another check is due. */
  dirty: boolean
  /** A forced sync could not run (one was in flight, or the alternate screen was on); the next run resets. */
  resetNext: boolean
}

/** Dependencies injected by the server for each connection. */
export interface ConnectionDeps {
  /** Remote address string for logging. */
  remoteAddress: string
  /** Send a typed message to this client. */
  send: (msg: ServerMessage) => void
  /** Broadcast to all connected clients. */
  broadcast: (msg: ServerMessage) => void
  /** How ptys are spawned. */
  ptySpawner?: PtySpawner
  /**
   * Claim ownership of a window for this client. Sends terminal:detached
   * to any previously attached clients and broadcasts updated ownership.
   */
  claimWindow: (windowId: number) => void
  /** Remove this client from all window ownership and broadcast the change. */
  releaseAllWindows: () => void
  /** User-Agent of the upgrade request, for the connection log. */
  userAgent: string
  /** Commit the server process was started from (server/build.ts). */
  serverBuild: string
  /** Build id of the client bundle on disk right now, or null. */
  servedClientBuild: () => Promise<string | null>
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

/** Runtime validation for WebSocket messages -- rejects malformed payloads before they reach handlers. */
function validateMessage(msg: unknown): ClientMessage {
  if (typeof msg !== 'object' || msg === null || !('type' in msg)) {
    throw new Error('Invalid message: missing type')
  }
  const { type } = msg as { type: string }
  switch (type) {
    case 'terminal:input':
      if (typeof (msg as any).windowId !== 'number' || typeof (msg as any).data !== 'string')
        throw new Error('Invalid terminal:input: requires numeric windowId and string data')
      break
    case 'terminal:resize':
      if (typeof (msg as any).windowId !== 'number' || typeof (msg as any).cols !== 'number' || typeof (msg as any).rows !== 'number')
        throw new Error('Invalid terminal:resize: requires numeric windowId, cols, rows')
      break
    case 'terminal:attach':
      if (typeof (msg as any).windowId !== 'number')
        throw new Error('Invalid terminal:attach: requires numeric windowId')
      break
    case 'session:kill':
    case 'session:rename':
      if (typeof (msg as any).windowId !== 'number')
        throw new Error(`Invalid ${type}: requires numeric windowId`)
      break
    case 'client:hello': {
      const { build } = msg as { build?: unknown }
      if (build !== null && typeof build !== 'string')
        throw new Error('Invalid message: client:hello requires build to be a string or null')
      break
    }
    // ping, session:list, session:create, files:* -- minimal validation
    default:
      break
  }
  return msg as ClientMessage
}

/**
 * Sanitize error messages before sending them to clients to avoid leaking
 * server-internal paths or other sensitive details.
 */
function safeErrorMessage(err: unknown): string {
  if (err instanceof Error) {
    const msg = err.message
    if ('code' in err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'ENOENT') return 'File or directory not found'
      if (code === 'EACCES') return 'Permission denied'
      if (code === 'EISDIR') return 'Path is a directory'
      if (code === 'ENOTDIR') return 'Not a directory'
    }
    // Keep messages from our own Error throws (they're safe)
    if (msg.startsWith('Invalid path') || msg.startsWith('File too large') || msg.startsWith('Invalid message') || msg.startsWith('Invalid terminal') || msg.startsWith('Invalid session'))
      return msg
    return 'Operation failed'
  }
  return 'Operation failed'
}

// ---------------------------------------------------------------------------
// Connection handler
// ---------------------------------------------------------------------------

/**
 * Set up per-connection state and message dispatch for a single WebSocket
 * client. Call this from the `wss.on('connection')` callback after the
 * welcome messages have been sent.
 */
export function handleConnection(ws: WebSocket, deps: ConnectionDeps): void {
  const {
    remoteAddress, send, broadcast, ptySpawner, claimWindow, releaseAllWindows,
    userAgent, serverBuild, servedClientBuild,
  } = deps

  // Track pty handles for this connection, keyed by windowId.
  const ptys = new Map<number, PtyHandle>()

  // History sent to this client, keyed by windowId. A tracker lives as
  // long as the pty it shadows; killing the pty drops it.
  const trackers = new Map<number, HistoryTracker>()

  const dropTracker = (windowId: number): void => {
    const tracker = trackers.get(windowId)
    if (!tracker) return
    if (tracker.timer) clearTimeout(tracker.timer)
    trackers.delete(windowId)
  }

  /** Check the history once output has settled; a burst becomes one check. */
  const scheduleHistory = (windowId: number): void => {
    const tracker = trackers.get(windowId)
    if (!tracker) return
    tracker.dirty = true
    if (tracker.timer || tracker.running) return
    tracker.timer = setTimeout(() => {
      tracker.timer = null
      void syncHistory(windowId)
    }, HISTORY_CHECK_MS)
  }

  /**
   * Bring the client's history up to date with the pane's. `force` sends
   * the whole history again (attach, resize reflow). One sync per window
   * runs at a time; a request that lands mid-run is folded into a rerun so
   * messages reach the client in order.
   */
  const syncHistory = async (windowId: number, force = false): Promise<void> => {
    const tracker = trackers.get(windowId)
    if (!tracker) return
    if (tracker.running) {
      tracker.dirty = true
      if (force) tracker.resetNext = true
      return
    }
    const reset = force || tracker.resetNext
    tracker.running = true
    tracker.dirty = false
    tracker.resetNext = false
    // The tracker can be dropped or replaced (re-attach, close) while tmux
    // answers; what came back then describes a client state that is gone.
    const stale = (): boolean => trackers.get(windowId) !== tracker
    try {
      const state = await paneHistoryState(windowId)
      if (stale()) return
      const plan = planHistoryUpdate(reset ? null : tracker.known, state)
      if (plan.kind === 'none') {
        // Only the alternate screen turns a reset into nothing: history is
        // frozen behind it, so the reset waits until it comes back.
        if (reset) tracker.resetNext = true
        return
      }
      if (plan.kind === 'sync') {
        const captured = await captureHistoryLines(windowId, Math.min(state.size, plan.count + HISTORY_TAIL))
        if (stale()) return
        const fresh = alignHistory(tracker.sentTail, captured)
        if (fresh !== null) {
          if (fresh.length > 0) {
            tracker.sentTail = nextTail(tracker.sentTail, fresh, HISTORY_TAIL)
            send({ type: 'terminal:history', windowId, lines: fresh, reset: false })
          }
          tracker.known = state.size
          return
        }
        // No overlap with what was sent: the client is too far behind to
        // append, so fall through and start it over.
      }
      // Only the tail the client will keep. `known` still records the full
      // size so later syncs append from the right place.
      const lines = await captureHistoryLines(windowId, Math.min(state.size, MAX_HISTORY_LINES))
      if (stale()) return
      tracker.sentTail = nextTail([], lines, HISTORY_TAIL)
      tracker.known = state.size
      send({ type: 'terminal:history', windowId, lines, reset: true })
    } catch (err) {
      console.error('[ws] history sync error:', err)
    } finally {
      tracker.running = false
      if (tracker.dirty && !stale()) scheduleHistory(windowId)
    }
  }

  // Track file-panel state for this connection: the cwd most recently
  // established via files:tree/files:watch, and the active directory
  // watcher (if any), so files:read/files:write know where to resolve
  // relative paths and files:watch can be swapped out cleanly.
  let currentCwd = ''
  let currentWatcher: Watcher | null = null

  ws.on('message', async (raw) => {
    try {
      const msg = validateMessage(JSON.parse(raw.toString()))
      switch (msg.type) {
        case 'ping': {
          send({ type: 'pong' })
          break
        }
        case 'client:hello': {
          // The one log line that says which bundle a device is running.
          console.log(`[ws] hello from ${remoteAddress} build=${msg.build ?? 'none'} ua="${userAgent}"`)
          send({ type: 'server:hello', serverBuild, clientBuild: await servedClientBuild() })
          break
        }
        case 'session:list': {
          const wins = await listWindows()
          send({ type: 'session:list', windows: wins })
          break
        }
        case 'session:create': {
          const win = await createWindow(msg.name, msg.cwd)
          broadcast({ type: 'session:created', window: win })
          break
        }
        case 'session:kill': {
          await killWindow(msg.windowId)
          broadcast({ type: 'session:killed', windowId: msg.windowId })
          break
        }
        case 'session:rename': {
          await renameWindow(msg.windowId, msg.name)
          broadcast({ type: 'session:renamed', windowId: msg.windowId, name: msg.name })
          break
        }
        case 'terminal:attach': {
          // Kill any existing pty for this window on this connection.
          const existing = ptys.get(msg.windowId)
          if (existing) existing.kill()
          dropTracker(msg.windowId)

          // The client's scrollback is the pane's history; send all of it
          // before the pty spawns so it sits above the live screen from
          // the first paint.
          trackers.set(msg.windowId, {
            known: null, sentTail: [], timer: null, running: false, dirty: false, resetNext: false,
          })
          await syncHistory(msg.windowId, true)

          // Single-owner handoff: whoever last attached to this window
          // "owns" it. Notify any previously attached clients (other
          // connections) that they've been taken over, then replace the
          // window's client set with just this one. This comes after the
          // history round-trip so the handoff and the spawn below happen
          // together, with nothing awaited in between.
          claimWindow(msg.windowId)

          // pty spawn can throw synchronously (e.g. no tmux binary, or no
          // real tmux session in a test/dev environment) -- ownership
          // tracking above should still hold even when this fails.
          try {
            const handle = attachToPane(
              msg.windowId,
              (data) => {
                send({ type: 'terminal:output', windowId: msg.windowId, data })
                scheduleHistory(msg.windowId)
              },
              { cols: msg.cols, rows: msg.rows },
              ptySpawner,
            )
            ptys.set(msg.windowId, handle)
          } catch (err) {
            console.error('[ws] pty attach error:', err)
            send({
              type: 'error',
              message: safeErrorMessage(err),
            })
          }
          break
        }
        case 'terminal:input': {
          const handle = ptys.get(msg.windowId)
          if (handle) handle.write(msg.data)
          break
        }
        case 'terminal:resize': {
          const cols = Math.max(1, Math.min(500, Math.round(msg.cols)))
          const rows = Math.max(1, Math.min(200, Math.round(msg.rows)))
          const handle = ptys.get(msg.windowId)
          if (handle) {
            handle.resize(cols, rows)
            // tmux reflows the history to the new width, so the lines the
            // client has no longer match; send the whole set again once
            // the reflow has landed.
            setTimeout(() => {
              void syncHistory(msg.windowId, true)
            }, HISTORY_REFLOW_MS)
          }
          break
        }
        case 'files:tree': {
          // Validate cwd: resolve to an absolute path and reject traversal.
          // TODO: in production, validate against the tmux session's actual cwd.
          const treeCwd = path.resolve(msg.cwd)
          if (msg.cwd.includes('..')) {
            throw new Error('Invalid path (path traversal is not allowed)')
          }
          // Establish/refresh the cwd for this connection so subsequent
          // files:read/files:write requests (which only carry a relative
          // path) know what to resolve against.
          currentCwd = treeCwd
          const entries = await getTree(treeCwd)
          send({ type: 'files:tree', entries })
          break
        }
        case 'files:read': {
          const content = await readFile(currentCwd, msg.path)
          send({ type: 'files:content', path: msg.path, content })
          break
        }
        case 'files:write': {
          await writeFile(currentCwd, msg.path, msg.content)
          send({ type: 'files:saved', path: msg.path })
          break
        }
        case 'files:watch': {
          // Validate cwd: resolve to an absolute path and reject traversal.
          // TODO: in production, validate against the tmux session's actual cwd.
          const watchCwd = path.resolve(msg.cwd)
          if (msg.cwd.includes('..')) {
            throw new Error('Invalid path (path traversal is not allowed)')
          }
          // Close any existing watcher for this connection before
          // starting a new one (e.g. the client switched directories).
          if (currentWatcher) currentWatcher.close()
          currentCwd = watchCwd
          currentWatcher = watchDir(watchCwd, async (changedPath) => {
            try {
              const content = await readFile(watchCwd, changedPath)
              send({ type: 'files:changed', path: changedPath, content })
            } catch (err) {
              // E.g. the file was deleted rather than changed -- nothing to
              // send, but don't let it become an unhandled rejection.
              console.error('[ws] files:watch change handling error:', err)
            }
          })
          break
        }
        case 'files:unwatch': {
          if (currentWatcher) {
            currentWatcher.close()
            currentWatcher = null
          }
          break
        }
        default:
          break
      }
    } catch (err) {
      console.error('[ws] message handling error:', err)
      send({
        type: 'error',
        message: safeErrorMessage(err),
      })
    }
  })

  ws.on('close', () => {
    console.log(`[ws] client disconnected (${remoteAddress})`)
    // Clean up all pty handles for this connection.
    for (const handle of ptys.values()) {
      handle.kill()
    }
    ptys.clear()
    for (const tracker of trackers.values()) {
      if (tracker.timer) clearTimeout(tracker.timer)
    }
    trackers.clear()

    // Clean up any active file watcher for this connection.
    if (currentWatcher) {
      currentWatcher.close()
      currentWatcher = null
    }

    // Drop this connection from ownership tracking and let everyone else
    // know the ownership snapshot changed.
    releaseAllWindows()
  })

  ws.on('error', (err) => {
    console.error('[ws] connection error:', err)
  })
}
