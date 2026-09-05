// Express + WebSocket server for Nest.
//
// Serves the built client (in production), accepts image uploads at
// POST /api/upload, and upgrades `/ws` connections for the
// terminal/session/file protocol defined in src/shared/protocol.ts.
// Run directly with `npm run dev:server` (tsx watch) or `npm start` (built).

import express from 'express'
import multer from 'multer'
import http from 'node:http'
import path from 'node:path'
import { existsSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { WebSocketServer, type WebSocket } from 'ws'
import type { ClientMessage, ServerMessage } from '../shared/protocol.ts'
import { listWindows, createWindow, killWindow, renameWindow, paneHistoryState, captureHistoryLines } from './tmux.ts'
import { planHistoryUpdate, alignHistory, nextTail } from './history.ts'
import { attachToPane, type PtyHandle, type PtySpawner } from './pty-bridge.ts'
import { getTree, readFile, writeFile, watchDir, type Watcher } from './files.ts'
import {
  DAY_MS,
  DEFAULT_MAX_UPLOAD_AGE_DAYS,
  DEFAULT_UPLOAD_DIR,
  UPLOAD_SWEEP_INITIAL_DELAY_MS,
  UPLOAD_SWEEP_INTERVAL_MS,
  purgeOldUploads,
  saveUpload,
  UnsupportedImageError,
} from './uploads.ts'
import {
  MAX_UPLOAD_BYTES,
  UPLOAD_FIELD_NAME,
  isSupportedImageType,
  type UploadErrorResponse,
  type UploadResponse,
} from '../shared/uploads.ts'

const DEFAULT_PORT = 3000

/** How often to re-list tmux sessions while at least one client is connected. */
export const DEFAULT_POLL_INTERVAL_MS = 2000

/**
 * How often to ping each client at the WebSocket protocol level. A client
 * that hasn't answered by the next tick is terminated, which releases its
 * ptys and its session ownership. Phones that lose signal or get frozen in
 * the background never send a close frame, so without this their ptys
 * would linger until the OS gives up on the TCP connection.
 */
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000

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

export interface ServerOptions {
  /** Override the tmux poll interval (tests use a short one). */
  pollIntervalMs?: number
  /** Where POST /api/upload saves files. Defaults to ~/uploads. */
  uploadDir?: string
  /**
   * Delete files in the upload dir older than this many days. The folder is
   * temp-only (anything worth keeping belongs in a project). 0 disables the
   * sweep. Defaults to DEFAULT_MAX_UPLOAD_AGE_DAYS.
   */
  maxUploadAgeDays?: number
  /** Override how often the upload sweep runs (tests use a short one). */
  uploadSweepIntervalMs?: number
  /** Override the protocol-level ping interval (tests use a short one). 0 disables. */
  heartbeatIntervalMs?: number
  /** Override how ptys are spawned (tests inject a fake). */
  ptySpawner?: PtySpawner
}

/** Send a protocol message to a single client, typed against ServerMessage. */
function send(ws: WebSocket, message: ServerMessage): void {
  ws.send(JSON.stringify(message))
}

/** Broadcast a protocol message to ALL connected clients. */
function broadcast(wss: WebSocketServer, message: ServerMessage): void {
  const payload = JSON.stringify(message)
  for (const client of wss.clients) {
    if (client.readyState === 1 /* WebSocket.OPEN */) {
      client.send(payload)
    }
  }
}

/**
 * POST /api/upload — receive one image as multipart/form-data (field "file"),
 * save it under `uploadDir`, and respond with its absolute path so the client
 * can type it into the shell. Rejects non-image MIME types before buffering
 * the body (415), anything over MAX_UPLOAD_BYTES (413), bodies whose bytes
 * don't actually look like an image (415), and requests with no file (400).
 */
function createUploadHandler(uploadDir: string): express.RequestHandler {
  const receive = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
    fileFilter: (_req, file, cb) => {
      if (isSupportedImageType(file.mimetype)) cb(null, true)
      else cb(new UnsupportedImageError(`unsupported file type: ${file.mimetype || 'unknown'}`))
    },
  }).single(UPLOAD_FIELD_NAME)

  return (req, res) => {
    const fail = (status: number, error: string): void => {
      const body: UploadErrorResponse = { error }
      res.status(status).json(body)
    }

    receive(req, res, async (err?: unknown) => {
      if (err instanceof UnsupportedImageError) return fail(415, err.message)
      if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          return fail(413, `file exceeds the ${MAX_UPLOAD_BYTES / (1024 * 1024)}MB upload limit`)
        }
        return fail(400, err.message)
      }
      if (err) {
        console.error('[upload] error receiving upload:', err)
        return fail(500, 'upload failed')
      }
      if (!req.file) return fail(400, `no file uploaded (expected multipart field "${UPLOAD_FIELD_NAME}")`)

      try {
        const saved = await saveUpload(req.file.buffer, uploadDir)
        const body: UploadResponse = { path: saved }
        res.json(body)
      } catch (saveErr) {
        if (saveErr instanceof UnsupportedImageError) return fail(415, saveErr.message)
        console.error('[upload] error saving upload:', saveErr)
        fail(500, 'failed to save upload')
      }
    })
  }
}

/** Build the Express app: health check, image upload, + (in production) static client. */
export function createApp(options: ServerOptions = {}): express.Express {
  const app = express()

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' })
  })

  app.post('/api/upload', createUploadHandler(options.uploadDir ?? DEFAULT_UPLOAD_DIR))

  // The server always runs from the project root (`tsx src/server/index.ts`,
  // whether via `npm run dev:server` or `npm start`), and `vite build`
  // writes the client bundle to `<project-root>/dist`. Resolve against
  // process.cwd() rather than __dirname so this doesn't depend on whether
  // the server itself is compiled or run in place.
  const clientDist = path.resolve(process.cwd(), 'dist')
  if (process.env.NODE_ENV === 'production' && existsSync(clientDist)) {
    app.use(express.static(clientDist))
    // SPA fallback: any unmatched route serves index.html. Registered as
    // plain middleware (not a route pattern) to stay clear of Express 5's
    // stricter wildcard route syntax.
    app.use((req, res, next) => {
      if (req.method !== 'GET') return next()
      res.sendFile(path.join(clientDist, 'index.html'))
    })
  }

  return app
}

export interface StartedServer {
  /** The underlying HTTP server, for tests/introspection. */
  server: http.Server
  /** The WebSocket server attached at `/ws`. */
  wss: WebSocketServer
  /** Base HTTP URL the server is listening on, e.g. http://localhost:3000 */
  url: string
  /** Stop accepting connections, terminate open sockets, and close the server. */
  close: () => Promise<void>
}

/**
 * Start the Nest server. Pass port 0 to let the OS assign a free port
 * (used by tests so multiple suites can run without colliding).
 */
export function startServer(
  port: number = DEFAULT_PORT,
  options: ServerOptions = {},
): Promise<StartedServer> {
  const app = createApp(options)
  const server = http.createServer(app)
  const wss = new WebSocketServer({ server, path: '/ws' })

  // Live refresh. Only changes made through Nest (create/kill/rename) reach
  // us as messages. A `cd` in the shell, or a program retitling its
  // terminal (Claude Code's /rename), changes what the sidebar should show
  // with no message at all. tmux has no hook for cwd changes, so while
  // anyone is connected we re-list every few seconds and broadcast only
  // when something differs. One tmux spawn per tick.
  let lastListing = ''
  let polling = false
  const pollTmux = async (): Promise<void> => {
    if (polling || wss.clients.size === 0) return
    polling = true
    try {
      const windows = await listWindows()
      const listing = JSON.stringify(windows)
      if (listing !== lastListing) {
        lastListing = listing
        broadcast(wss, { type: 'session:list', windows })
      }
    } finally {
      polling = false
    }
  }
  const pollTimer = setInterval(() => {
    void pollTmux()
  }, options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS)
  // Never keep the process alive just to poll; tests close servers and expect to exit.
  pollTimer.unref()

  // Upload housekeeping. ~/uploads is temp-only by convention (anything
  // worth keeping belongs in a project), so sweep out files older than
  // maxUploadAgeDays. The first sweep waits UPLOAD_SWEEP_INITIAL_DELAY_MS
  // rather than running at startup so short-lived servers (the test suites)
  // never touch a real ~/uploads; after that it repeats every
  // uploadSweepIntervalMs. Chained timeouts rather than setInterval so two
  // sweeps can never overlap.
  const uploadDir = options.uploadDir ?? DEFAULT_UPLOAD_DIR
  const maxUploadAgeDays = options.maxUploadAgeDays ?? DEFAULT_MAX_UPLOAD_AGE_DAYS
  const sweepIntervalMs = options.uploadSweepIntervalMs ?? UPLOAD_SWEEP_INTERVAL_MS
  const sweepUploads = async (): Promise<void> => {
    try {
      const deleted = await purgeOldUploads(uploadDir, maxUploadAgeDays * DAY_MS)
      if (deleted.length > 0) {
        console.log(`[uploads] purged ${deleted.length} file(s) older than ${maxUploadAgeDays}d from ${uploadDir}`)
      }
    } catch (err) {
      console.error('[uploads] sweep failed:', err)
    }
  }
  let sweepTimer: ReturnType<typeof setTimeout> | null = null
  let sweepStopped = false
  const scheduleSweep = (delayMs: number): void => {
    if (sweepStopped) return
    sweepTimer = setTimeout(() => {
      void sweepUploads().finally(() => scheduleSweep(sweepIntervalMs))
    }, delayMs)
    sweepTimer.unref()
  }
  if (maxUploadAgeDays > 0) scheduleSweep(Math.min(sweepIntervalMs, UPLOAD_SWEEP_INITIAL_DELAY_MS))

  // Liveness: ping every client each tick; anyone who didn't pong since the
  // last tick is gone. `alive` flips true on connect and on every pong.
  const alive = new WeakMap<WebSocket, boolean>()
  const heartbeatMs = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS
  const heartbeatTimer = heartbeatMs > 0
    ? setInterval(() => {
        for (const client of wss.clients) {
          if (alive.get(client) === false) {
            client.terminate()
            continue
          }
          alive.set(client, false)
          client.ping()
        }
      }, heartbeatMs)
    : null
  heartbeatTimer?.unref()

  // Session handoff / ownership tracking for THIS server instance: which
  // WebSocket connections are currently attached (via terminal:attach) to
  // which tmux window. Purely in-memory — exists only to support
  // "single owner" handoff (a new attach takes over from any previous
  // attachers) and to let clients show an ownership indicator. Scoped per
  // server instance (rather than module-level) so multiple servers started
  // in the same process — as tests do — don't share state.
  const windowClients = new Map<number, Set<WebSocket>>()

  /** Current ownership snapshot: how many clients are attached to each window. */
  const getOwnership = (): Array<{ windowId: number; clients: number }> =>
    Array.from(windowClients.entries())
      .filter(([, clients]) => clients.size > 0)
      .map(([windowId, clients]) => ({ windowId, clients: clients.size }))

  /** Broadcast the current ownership snapshot to every connected client. */
  const broadcastOwnership = (): void => {
    broadcast(wss, { type: 'session:ownership', ownership: getOwnership() })
  }

  /** Remove a disconnecting client from every window's client set. */
  const removeClientFromAllWindows = (ws: WebSocket): void => {
    for (const [windowId, clients] of windowClients) {
      if (clients.delete(ws) && clients.size === 0) {
        windowClients.delete(windowId)
      }
    }
  }

  wss.on('connection', async (ws, req) => {
    const remote = req.socket.remoteAddress ?? 'unknown'
    console.log(`[ws] client connected from ${remote}`)
    alive.set(ws, true)
    ws.on('pong', () => alive.set(ws, true))

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
              send(ws, { type: 'terminal:history', windowId, lines: fresh, reset: false })
            }
            tracker.known = state.size
            return
          }
          // No overlap with what was sent: the client is too far behind to
          // append, so fall through and start it over.
        }
        const lines = await captureHistoryLines(windowId, state.size)
        if (stale()) return
        tracker.sentTail = nextTail([], lines, HISTORY_TAIL)
        tracker.known = state.size
        send(ws, { type: 'terminal:history', windowId, lines, reset: true })
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

    // Welcome message: send the real tmux window list. If any windows
    // already have clients attached (e.g. this connection is a browser tab
    // reconnecting to a server other tabs are already using), follow up
    // with the current ownership snapshot so the new client can render
    // indicators immediately — but omit it entirely when there's nothing to
    // report, so a freshly started server's welcome sequence stays a single
    // message.
    const windows = await listWindows()
    lastListing = JSON.stringify(windows)
    send(ws, { type: 'session:list', windows })
    const initialOwnership = getOwnership()
    if (initialOwnership.length > 0) {
      send(ws, { type: 'session:ownership', ownership: initialOwnership })
    }

    ws.on('message', async (raw) => {
      try {
        const msg = JSON.parse(raw.toString()) as ClientMessage
        switch (msg.type) {
          case 'ping': {
            send(ws, { type: 'pong' })
            break
          }
          case 'session:list': {
            const wins = await listWindows()
            send(ws, { type: 'session:list', windows: wins })
            break
          }
          case 'session:create': {
            const win = await createWindow(msg.name, msg.cwd)
            broadcast(wss, { type: 'session:created', window: win })
            break
          }
          case 'session:kill': {
            await killWindow(msg.windowId)
            broadcast(wss, { type: 'session:killed', windowId: msg.windowId })
            break
          }
          case 'session:rename': {
            await renameWindow(msg.windowId, msg.name)
            broadcast(wss, { type: 'session:renamed', windowId: msg.windowId, name: msg.name })
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
            const previousClients = windowClients.get(msg.windowId)
            if (previousClients) {
              for (const client of previousClients) {
                if (client !== ws) {
                  send(client, { type: 'terminal:detached', windowId: msg.windowId, reason: 'taken-over' })
                }
              }
            }
            windowClients.set(msg.windowId, new Set([ws]))
            broadcastOwnership()

            // pty spawn can throw synchronously (e.g. no tmux binary, or no
            // real tmux session in a test/dev environment) — ownership
            // tracking above should still hold even when this fails.
            try {
              const handle = attachToPane(
                msg.windowId,
                (data) => {
                  send(ws, { type: 'terminal:output', windowId: msg.windowId, data })
                  scheduleHistory(msg.windowId)
                },
                { cols: msg.cols, rows: msg.rows },
                options.ptySpawner,
              )
              ptys.set(msg.windowId, handle)
            } catch (err) {
              console.error('[ws] pty attach error:', err)
              send(ws, {
                type: 'error',
                message: err instanceof Error ? err.message : String(err),
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
            const handle = ptys.get(msg.windowId)
            if (handle) {
              handle.resize(msg.cols, msg.rows)
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
            // Establish/refresh the cwd for this connection so subsequent
            // files:read/files:write requests (which only carry a relative
            // path) know what to resolve against.
            currentCwd = msg.cwd
            const entries = await getTree(msg.cwd)
            send(ws, { type: 'files:tree', entries })
            break
          }
          case 'files:read': {
            const content = await readFile(currentCwd, msg.path)
            send(ws, { type: 'files:content', path: msg.path, content })
            break
          }
          case 'files:write': {
            await writeFile(currentCwd, msg.path, msg.content)
            send(ws, { type: 'files:saved', path: msg.path })
            break
          }
          case 'files:watch': {
            // Close any existing watcher for this connection before
            // starting a new one (e.g. the client switched directories).
            if (currentWatcher) currentWatcher.close()
            currentCwd = msg.cwd
            currentWatcher = watchDir(msg.cwd, async (changedPath) => {
              try {
                const content = await readFile(msg.cwd, changedPath)
                send(ws, { type: 'files:changed', path: changedPath, content })
              } catch (err) {
                // E.g. the file was deleted rather than changed — nothing to
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
        send(ws, {
          type: 'error',
          message: err instanceof Error ? err.message : String(err),
        })
      }
    })

    ws.on('close', () => {
      console.log(`[ws] client disconnected (${remote})`)
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
      removeClientFromAllWindows(ws)
      broadcastOwnership()
    })

    ws.on('error', (err) => {
      console.error('[ws] connection error:', err)
    })
  })

  return new Promise<StartedServer>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, () => {
      server.removeListener('error', reject)

      const address = server.address()
      const actualPort = typeof address === 'object' && address ? address.port : port
      const url = `http://localhost:${actualPort}`
      console.log(`[server] listening on ${url}`)

      const close = (): Promise<void> =>
        new Promise<void>((resolveClose, rejectClose) => {
          clearInterval(pollTimer)
          if (heartbeatTimer) clearInterval(heartbeatTimer)
          sweepStopped = true
          if (sweepTimer) clearTimeout(sweepTimer)
          for (const client of wss.clients) {
            client.terminate()
          }
          wss.close((err) => {
            if (err) {
              rejectClose(err)
              return
            }
            server.close((closeErr) => {
              if (closeErr) {
                rejectClose(closeErr)
                return
              }
              resolveClose()
            })
          })
        })

      resolve({ server, wss, url, close })
    })
  })
}

// Only auto-start when this file is run directly (e.g. `tsx src/server/index.ts`
// or `tsx watch ...`), not when imported by tests.
const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) {
  const envPort = process.env.PORT ? parseInt(process.env.PORT, 10) : NaN
  const port = Number.isFinite(envPort) ? envPort : DEFAULT_PORT
  startServer(port).catch((err) => {
    console.error('Failed to start server:', err)
    process.exit(1)
  })
}
