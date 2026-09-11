// Express + WebSocket server for Foray.
//
// Serves the built client (in production), accepts image uploads at
// POST /api/upload, and upgrades `/ws` connections for the
// terminal/session/file protocol defined in src/shared/protocol.ts.
// Run directly with `npm start` (`tsx src/server/index.ts`).

import express from 'express'
import multer from 'multer'
import http from 'node:http'
import path from 'node:path'
import { existsSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { WebSocketServer, type WebSocket } from 'ws'
import type { ServerMessage, TmuxWindow } from '../shared/protocol.ts'
import { applyTmuxServerOptions, listWindows, mirrorTitles, type TmuxExecutor } from './tmux.ts'
import type { PtySpawner } from './pty-bridge.ts'
import { handleConnection, type Connection } from './ws-handler.ts'
import { PastSessions } from './pastSessions.ts'
import { providersFromEnv } from './agents/index.ts'
import type { AgentProvider } from './agents/types.ts'
import { describeCheckout, readServedClientBuild } from './build.ts'
import {
  Auth, clientAddress, loadToken, originAllowed, isSecureRequest, parseCookies, requestHosts, SESSION_COOKIE, type AuthOptions,
} from './auth.ts'
import { SILENT, scopedLog, type Logger } from './log.ts'
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
 * Largest WebSocket frame accepted from a client. The biggest legitimate
 * message is a files:write of a file the panel could read (1 MiB), with
 * JSON escaping on top. Anything larger closes the socket before it is
 * buffered, which on a small box is the difference between a nuisance and
 * an out-of-memory kill.
 */
export const MAX_WS_PAYLOAD_BYTES = 2 * 1024 * 1024

/** Most WebSocket clients at once; each attach costs a tmux client and a pty. */
export const DEFAULT_MAX_CONNECTIONS = 64

/** Largest login body; the token is 43 characters. */
const MAX_LOGIN_BODY = '4kb'

export interface ServerOptions {
  /**
   * Interface to listen on. Default: every interface, which assumes a
   * private network (DEPLOY.md); set to 127.0.0.1 to keep it local.
   */
  host?: string
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
  /** Override how tmux is invoked (tests inject an in-memory fake). */
  tmuxExec?: TmuxExecutor
  /**
   * Agents whose past sessions the sidebar lists (src/server/agents).
   * Defaults to those found on this machine per the environment; tests
   * pass [] so they never read this machine's transcripts.
   */
  agents?: AgentProvider[]
  /**
   * Directory holding the built client to serve. Defaults to <cwd>/dist
   * when NODE_ENV is production, and to nothing otherwise; an explicit
   * value is served regardless of NODE_ENV (tests point it at a fixture).
   */
  clientDist?: string
  /** Where log lines go. Defaults to the console. */
  logger?: Logger
  /** Drop all log output (tests); shorthand for a no-op `logger`. */
  quiet?: boolean
  /**
   * How callers prove they may use the server (server/auth.ts). Default:
   * the token from FORAY_TOKEN or ~/.foray/token. `false` turns
   * authentication off, which the entry point allows only on a loopback
   * address; tests use it where the connection is not the point.
   */
  auth?: AuthOptions | false
  /**
   * Host names (no port) requests may address the server by. Empty means
   * any. With a value, a request whose Host header names anything else is
   * refused, which stops DNS rebinding even before authentication does.
   * From FORAY_ALLOWED_HOSTS (comma-separated) at the entry point.
   */
  allowedHosts?: string[]
  /** Override the WebSocket client cap (DEFAULT_MAX_CONNECTIONS). */
  maxConnections?: number
}

/** The Auth for `options`, or null when authentication is off. */
function authFor(options: ServerOptions, logger: Logger): Auth | null {
  if (options.auth === false) return null
  const loaded = loadToken(options.auth ?? {})
  const log = scopedLog(logger, 'auth')
  if (loaded.source === 'file') {
    log.log(`token ${loaded.created ? 'created at' : 'read from'} ${loaded.file} (npm run token prints it)`)
  } else if (loaded.source === 'env') {
    log.log('token from FORAY_TOKEN')
  }
  return new Auth(loaded.token, options.auth || {})
}

/** The host name of a Host header, without the port. */
function hostNameOf(host: string | undefined): string {
  if (!host) return ''
  const bracket = host.lastIndexOf(']')
  const colon = host.lastIndexOf(':')
  return (colon > bracket ? host.slice(0, colon) : host).toLowerCase()
}

/** Whether a request's Host header is one of `allowedHosts` (or there is no list). */
function hostAllowed(req: http.IncomingMessage, allowedHosts: string[] | undefined): boolean {
  if (!allowedHosts || allowedHosts.length === 0) return true
  const name = hostNameOf(req.headers.host)
  return allowedHosts.some((allowed) => allowed.toLowerCase() === name)
}

/**
 * The Content-Security-Policy for a request. The bundle and its styles
 * are same-origin; React and the scrollback renderer set inline style
 * attributes; the socket is spelled out per host because some browsers do
 * not count WebSockets as 'self'. No frames, no plugins, no other origins.
 */
function contentSecurityPolicy(req: http.IncomingMessage): string {
  const socket = requestHosts(req).map((host) => ` ws://${host} wss://${host}`).join('')
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    `connect-src 'self'${socket}`,
    "worker-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
  ].join('; ')
}

/** Headers every response carries. */
function securityHeaders(allowedHosts: string[] | undefined): express.RequestHandler {
  return (req, res, next) => {
    if (!hostAllowed(req, allowedHosts)) {
      res.status(421).type('text/plain').send('Unknown host')
      return
    }
    res.setHeader('Content-Security-Policy', contentSecurityPolicy(req))
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('X-Frame-Options', 'DENY')
    res.setHeader('Referrer-Policy', 'no-referrer')
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()')
    if (isSecureRequest(req)) res.setHeader('Strict-Transport-Security', 'max-age=31536000')
    if (req.path.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store')
    next()
  }
}

/**
 * The login, session and logout routes. A browser posts the token once
 * and holds a cookie from then on; GET /api/session is how the client
 * learns whether it is logged in (and slides the cookie's expiry).
 */
function installAuthRoutes(app: express.Express, auth: Auth | null, logger: Logger): void {
  const log = scopedLog(logger, 'auth')

  app.get('/api/session', (req, res) => {
    if (!auth) {
      res.json({ authenticated: true, required: false })
      return
    }
    if (!auth.isAuthenticated(req)) {
      res.status(401).json({ authenticated: false, required: true })
      return
    }
    // A fresh cookie each check, so a device in daily use never expires.
    if (parseCookies(req.headers.cookie).has(SESSION_COOKIE)) {
      res.setHeader('Set-Cookie', auth.cookieHeader(auth.issueSession(), isSecureRequest(req)))
    }
    res.json({ authenticated: true, required: true })
  })

  app.post('/api/login', express.json({ limit: MAX_LOGIN_BODY }), (req, res) => {
    if (!auth) {
      res.json({ ok: true })
      return
    }
    if (!originAllowed(req)) {
      log.log(`refused cross-origin login: origin=${req.headers.origin} host=${req.headers.host}`)
      res.status(403).json({ error: 'cross-origin login refused' })
      return
    }
    const address = clientAddress(req)
    const waitMs = auth.loginDelayMs(address)
    if (waitMs > 0) {
      const retryAfterS = Math.ceil(waitMs / 1000)
      res.setHeader('Retry-After', String(retryAfterS))
      res.status(429).json({ error: `too many attempts; try again in ${retryAfterS}s`, retryAfterS })
      return
    }
    const token = (req.body as { token?: unknown } | undefined)?.token
    if (!auth.verifyToken(token)) {
      auth.recordLoginFailure(address)
      log.log(`login failed from ${address}`)
      res.status(401).json({ error: 'wrong token' })
      return
    }
    auth.recordLoginSuccess(address)
    log.log(`login from ${address}`)
    res.setHeader('Set-Cookie', auth.cookieHeader(auth.issueSession(), isSecureRequest(req)))
    res.json({ ok: true })
  })

  app.post('/api/logout', requireAuth(auth), (req, res) => {
    if (auth) res.setHeader('Set-Cookie', auth.cookieHeader('', isSecureRequest(req)))
    res.json({ ok: true })
  })
}

/** Refuse a request that is cross-origin (403) or carries no valid credential (401). */
function requireAuth(auth: Auth | null): express.RequestHandler {
  return (req, res, next) => {
    if (!originAllowed(req)) {
      res.status(403).json({ error: 'cross-origin request refused' })
      return
    }
    if (auth && !auth.isAuthenticated(req)) {
      res.status(401).json({ error: 'not logged in' })
      return
    }
    next()
  }
}

/** Where the server's log lines go, per `ServerOptions.logger` and `quiet`. */
function loggerFor(options: ServerOptions): Logger {
  return options.logger ?? (options.quiet ? SILENT : console)
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
function createUploadHandler(uploadDir: string, logger: Logger): express.RequestHandler {
  const log = scopedLog(logger, 'upload')
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
        log.error('error receiving upload:', err)
        return fail(500, 'upload failed')
      }
      if (!req.file) return fail(400, `no file uploaded (expected multipart field "${UPLOAD_FIELD_NAME}")`)

      try {
        const saved = await saveUpload(req.file.buffer, uploadDir)
        const body: UploadResponse = { path: saved }
        res.json(body)
      } catch (saveErr) {
        if (saveErr instanceof UnsupportedImageError) return fail(415, saveErr.message)
        log.error('error saving upload:', saveErr)
        fail(500, 'failed to save upload')
      }
    })
  }
}

/**
 * Build the Express app: health check, login, image upload, + (in
 * production) static client. `auth` is the server's; it defaults to one
 * built from `options` for callers that only want the app.
 */
export function createApp(
  options: ServerOptions = {},
  auth: Auth | null = authFor(options, loggerFor(options)),
): express.Express {
  const app = express()
  const logger = loggerFor(options)
  app.disable('x-powered-by')
  app.use(securityHeaders(options.allowedHosts))

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' })
  })

  installAuthRoutes(app, auth, logger)
  app.post('/api/upload', requireAuth(auth), createUploadHandler(options.uploadDir ?? DEFAULT_UPLOAD_DIR, logger))

  const clientDist = servedClientDist(options)
  if (clientDist && existsSync(clientDist)) {
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
 * Where the built client lives. The server always runs from the project
 * root (`tsx src/server/index.ts`, via `npm start` or scripts/start.sh),
 * and `vite build` writes to `<project-root>/dist`. Resolved against
 * process.cwd() rather than __dirname so this doesn't depend on whether the
 * server itself is compiled or run in place.
 */
function clientDistDir(): string {
  return path.resolve(process.cwd(), 'dist')
}

/** The client directory to serve, or null when this server serves no client. */
function servedClientDist(options: ServerOptions): string | null {
  if (options.clientDist) return options.clientDist
  return process.env.NODE_ENV === 'production' ? clientDistDir() : null
}

/**
 * Start the Foray server. Pass port 0 to let the OS assign a free port
 * (used by tests so multiple suites can run without colliding).
 */
export function startServer(
  port: number = DEFAULT_PORT,
  options: ServerOptions = {},
): Promise<StartedServer> {
  const logger = loggerFor(options)
  const log = scopedLog(logger, 'server')
  const auth = authFor(options, logger)
  if (!auth) log.log('authentication is OFF: anyone who can reach this port has a shell')
  const app = createApp(options, auth)
  // Read once: tsx runs the source as of now, until the next restart.
  const serverBuild = describeCheckout()
  const server = http.createServer(app)
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_WS_PAYLOAD_BYTES })
  const maxConnections = options.maxConnections ?? DEFAULT_MAX_CONNECTIONS

  // The upgrade is where a browser page from anywhere on the network
  // would get in: it is let through only when it names this server as
  // its Origin (or is not a browser page), addresses an allowed host, and
  // carries a credential. Refusals answer with a plain HTTP status so a
  // client can tell "not logged in" from "not there".
  const refuse = (socket: import('node:stream').Duplex, status: number, reason: string): void => {
    socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
    socket.destroy()
  }
  server.on('upgrade', (req, socket, head) => {
    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname
    if (pathname !== '/ws') return refuse(socket, 404, 'Not Found')
    if (!hostAllowed(req, options.allowedHosts)) return refuse(socket, 421, 'Misdirected Request')
    if (!originAllowed(req)) {
      // Host and Origin in the log: behind a proxy that rewrites Host
      // without X-Forwarded-Host, this is the line that explains the 403.
      log.log(`refused cross-origin socket from ${clientAddress(req)}: origin=${req.headers.origin} host=${req.headers.host}`)
      return refuse(socket, 403, 'Forbidden')
    }
    if (auth && !auth.isAuthenticated(req)) return refuse(socket, 401, 'Unauthorized')
    if (wss.clients.size >= maxConnections) return refuse(socket, 503, 'Service Unavailable')
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req))
  })

  const tmuxExec = options.tmuxExec

  // The four options Foray needs — modified keys as CSI u, mouse off, and a
  // 10k scrollback — are set by scripts/foray.tmux.conf when tmux starts the
  // server, but tmux honours -f only then. A server that is not up yet cannot
  // take them, and one that exits (it does, with its last session) comes back
  // without them, so the listing below re-asserts them on every server it sees.
  let serverOptionsSet = false
  const ensureServerOptions = async (): Promise<void> => {
    if (serverOptionsSet) return
    serverOptionsSet = await applyTmuxServerOptions(tmuxExec)
  }
  void ensureServerOptions()

  // Live refresh. Only changes made through Foray (create/kill/rename) reach
  // us as messages. A `cd` in the shell, or a program retitling its
  // terminal (Claude Code's /rename), changes what the sidebar should show
  // with no message at all. tmux has no hook for cwd changes, so while
  // anyone is connected we re-list every few seconds and broadcast only
  // when something differs. One tmux spawn per tick.
  let lastWindows: TmuxWindow[] = []
  let lastListing = ''
  /** The session list now, or the last good one when tmux itself failed. */
  const currentWindows = async (): Promise<TmuxWindow[]> => {
    try {
      // Unnamed sessions take their program's title as their tmux name.
      lastWindows = await mirrorTitles(await listWindows(tmuxExec), tmuxExec)
      // A listing proves the tmux server is up; an empty one is what a
      // server that has gone looks like, and its successor starts bare.
      if (lastWindows.length > 0) void ensureServerOptions()
      else serverOptionsSet = false
    } catch (err) {
      log.error('list-sessions failed:', err)
    }
    return lastWindows
  }
  let polling = false
  const pollTmux = async (): Promise<void> => {
    if (polling || wss.clients.size === 0) return
    polling = true
    try {
      const windows = await currentWindows()
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
        log.log(`purged ${deleted.length} upload(s) older than ${maxUploadAgeDays}d from ${uploadDir}`)
      }
    } catch (err) {
      log.error('upload sweep failed:', err)
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
  // which tmux window. Purely in-memory: it exists to support "single
  // owner" handoff (a new attach takes over from any previous attachers)
  // and to let clients show an ownership indicator. Scoped per server
  // instance (rather than module-level) so multiple servers started in the
  // same process, as tests do, don't share state.
  const windowClients = new Map<number, Set<WebSocket>>()

  // Every live connection's handler, so a request on one connection
  // (session:kill, a handoff) can drop the attachments others hold.
  const connections = new Map<WebSocket, Connection>()

  /** Current ownership snapshot: how many clients are attached to each window. */
  const getOwnership = (): Array<{ windowId: number; clients: number }> =>
    Array.from(windowClients.entries())
      .filter(([, clients]) => clients.size > 0)
      .map(([windowId, clients]) => ({ windowId, clients: clients.size }))

  /** Broadcast the current ownership snapshot to every connected client. */
  const broadcastOwnership = (): void => {
    broadcast(wss, { type: 'session:ownership', ownership: getOwnership() })
  }

  /** Drop a client from one window's client set; true if it was there. */
  const releaseWindow = (ws: WebSocket, windowId: number): boolean => {
    const clients = windowClients.get(windowId)
    if (!clients?.delete(ws)) return false
    if (clients.size === 0) windowClients.delete(windowId)
    return true
  }

  const pastSessions = new PastSessions(options.agents ?? providersFromEnv(), { tmuxExec })

  wss.on('connection', (ws, req) => {
    const remote = req.socket.remoteAddress ?? 'unknown'
    const userAgent = String(req.headers['user-agent'] ?? '').slice(0, 160)
    log.log(`client connected from ${remote} ua="${userAgent}"`)
    alive.set(ws, true)
    ws.on('pong', () => alive.set(ws, true))

    const connection = handleConnection(ws, {
      remoteAddress: remote,
      send: (msg) => send(ws, msg),
      broadcast: (msg) => broadcast(wss, msg),
      ptySpawner: options.ptySpawner,
      tmuxExec,
      pastSessions,
      logger,
      // The welcome is the session list. If any windows already have
      // clients attached (this is a tab reconnecting to a server other
      // tabs are using), follow up with the ownership snapshot so the new
      // client can render indicators immediately; omit it when there is
      // nothing to report, so a fresh server's welcome stays one message.
      welcome: async () => {
        const windows = await currentWindows()
        lastListing = JSON.stringify(windows)
        send(ws, { type: 'session:list', windows })
        const initialOwnership = getOwnership()
        if (initialOwnership.length > 0) {
          send(ws, { type: 'session:ownership', ownership: initialOwnership })
        }
      },
      claimWindow: (windowId) => {
        // Whoever attached last owns the window: everyone else attached to
        // it loses their pty and is told why.
        for (const client of windowClients.get(windowId) ?? []) {
          if (client === ws) continue
          connections.get(client)?.dropAttachment(windowId)
          send(client, { type: 'terminal:detached', windowId, reason: 'taken-over' })
        }
        windowClients.set(windowId, new Set([ws]))
        broadcastOwnership()
      },
      releaseWindow: (windowId) => {
        if (releaseWindow(ws, windowId)) broadcastOwnership()
      },
      releaseAllWindows: () => {
        for (const windowId of [...windowClients.keys()]) releaseWindow(ws, windowId)
        broadcastOwnership()
      },
      dropAttachmentsFor: (windowId) => {
        for (const other of connections.values()) other.dropAttachment(windowId)
        if (windowClients.delete(windowId)) broadcastOwnership()
      },
      userAgent,
      serverBuild,
      servedClientBuild: () => readServedClientBuild(options.clientDist ?? clientDistDir()),
    })
    connections.set(ws, connection)
    ws.on('close', () => connections.delete(ws))
  })

  return new Promise<StartedServer>((resolve, reject) => {
    server.once('error', reject)
    const onListening = (): void => {
      server.removeListener('error', reject)

      const address = server.address()
      const actualPort = typeof address === 'object' && address ? address.port : port
      const url = `http://localhost:${actualPort}`
      log.log(`listening on ${url}${options.host ? ` (${options.host})` : ''}`)

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
    }
    if (options.host) server.listen(port, options.host, onListening)
    else server.listen(port, onListening)
  })
}

// Only auto-start when this file is run directly (e.g. `tsx src/server/index.ts`
// or `tsx watch ...`), not when imported by tests.
const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) {
  const envPort = process.env.PORT ? parseInt(process.env.PORT, 10) : NaN
  const port = Number.isFinite(envPort) ? envPort : DEFAULT_PORT
  const host = process.env.HOST || undefined
  const authOff = process.env.FORAY_AUTH === 'off'
  if (authOff && !isLoopback(host)) {
    console.error('FORAY_AUTH=off is only allowed together with HOST=127.0.0.1 (or ::1): without a token, anyone who can reach the port has a shell')
    process.exit(1)
  }
  const allowedHosts = (process.env.FORAY_ALLOWED_HOSTS ?? '').split(',').map((h) => h.trim()).filter(Boolean)
  startServer(port, { host, auth: authOff ? false : undefined, allowedHosts }).catch((err) => {
    console.error('Failed to start server:', err instanceof Error ? err.message : err)
    process.exit(1)
  })
}

/** Whether a listen address reaches only this machine. */
export function isLoopback(host: string | undefined): boolean {
  if (!host) return false
  const h = host.toLowerCase()
  return h === 'localhost' || h === '::1' || h.startsWith('127.')
}
