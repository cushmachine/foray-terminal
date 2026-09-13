// Per-connection WebSocket handler for Foray.
//
// Owns one client's attachments (pty, history tracker and timers per
// window), its file-panel state, and the validation and dispatch of its
// messages. Messages on one socket are handled one at a time, in order, so
// an input that follows an attach finds the pty it was typed into. The one
// exception is the liveness ping, answered at once.

import type { WebSocket } from 'ws'
import { MAX_HISTORY_LINES, type ClientMessage, type ErrorMessage, type ServerMessage } from '../shared/protocol.ts'
import {
  listWindows, createWindow, killWindow, renameWindow, runInWindow, unmarkNamed, paneHistoryState,
  captureHistoryLines, type TmuxExecutor,
} from './tmux.ts'
import type { PastSessions } from './pastSessions.ts'
import { planHistoryUpdate, alignHistory, nextTail } from './history.ts'
import { attachToPane, type PtyHandle, type PtySpawner } from './pty-bridge.ts'
import { getTree, readFile, writeFile, watchDir, resolveRoot, type Watcher } from './files.ts'
import { ClientError, safeErrorMessage } from './errors.ts'
import { scopedLog, type Logger } from './log.ts'

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
 * overlap with these. Rows captured per sync are the new rows plus this
 * many, so a line wrapped over more rows than this at the tail cannot be
 * matched and costs a reset.
 */
const HISTORY_TAIL = 50

/**
 * How long after the last resize of a burst to wait before checking the
 * history. tmux reflows wrapped rows to the new width, which moves the
 * row count but not the lines the client has (they are captured joined),
 * so the check finds nothing to send unless a line crossed into or out
 * of the visible screen; it is here for the redraw tmux may not produce.
 */
const HISTORY_REFLOW_MS = 150

/**
 * Backpressure. A pane that floods (cat of a big file) fills the socket's
 * send buffer faster than a phone drains it. Past the high mark the pty is
 * paused, which blocks the program behind it; it is resumed once the
 * buffer has drained below the low mark.
 */
const BACKPRESSURE_HIGH = 1024 * 1024
const BACKPRESSURE_LOW = 256 * 1024
const BACKPRESSURE_POLL_MS = 50

/** Terminal sizes accepted from a client, whatever it claims to measure. */
const MAX_COLS = 500
const MAX_ROWS = 200

/**
 * Windows one connection may hold ptys for at once. A page shows one
 * terminal per session and attaches to the one in front, so this is
 * headroom, not a working figure; each attach is a tmux client and a pty.
 */
export const MAX_ATTACHMENTS = 16

/** Longest terminal:input; a paste, not a file. */
export const MAX_INPUT_CHARS = 256 * 1024

/** Longest files:write content, the same as the panel will read back. */
export const MAX_WRITE_CHARS = 1024 * 1024

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

/** Everything this connection holds for one window it is attached to. */
interface Attachment {
  windowId: number
  /** Null until the history that precedes the spawn has been sent. */
  pty: PtyHandle | null
  tracker: HistoryTracker
  /** Pending history check after a resize burst. */
  reflowTimer: ReturnType<typeof setTimeout> | null
  /** Polling for the socket buffer to drain while the pty is paused. */
  drainTimer: ReturnType<typeof setInterval> | null
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
  /** How tmux is invoked; undefined means the real binary. */
  tmuxExec?: TmuxExecutor
  /** Past agent sessions and their revival; undefined means none are configured. */
  pastSessions?: PastSessions
  logger: Logger
  /**
   * Send the welcome (session list and, if any, ownership). Runs as the
   * first item of the connection's queue, so nothing is handled before it.
   */
  welcome: () => Promise<void>
  /**
   * Claim ownership of a window for this client. Detaches any previously
   * attached clients and broadcasts updated ownership.
   */
  claimWindow: (windowId: number) => void
  /** Drop this client from one window's ownership and broadcast if that changed anything. */
  releaseWindow: (windowId: number) => void
  /** Remove this client from all window ownership and broadcast the change. */
  releaseAllWindows: () => void
  /** Drop every connection's attachment to a window that no longer exists, and its ownership. */
  dropAttachmentsFor: (windowId: number) => void
  /** User-Agent of the upgrade request, for the connection log. */
  userAgent: string
  /** Commit the server process was started from (server/build.ts). */
  serverBuild: string
  /** Directory the server runs from: where `npm run deploy` has to run. */
  serverRoot: string
  /** Build id of the client bundle on disk right now, or null. */
  servedClientBuild: () => Promise<string | null>
}

/** What the server keeps per connection, to reach into it from other connections' requests. */
export interface Connection {
  /** Kill this connection's pty for a window and forget it; ownership is the caller's business. */
  dropAttachment: (windowId: number) => void
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const isString = (value: unknown): boolean => typeof value === 'string'
const isNumber = (value: unknown): boolean => typeof value === 'number' && Number.isFinite(value)
/** A tmux id: what `$${id}` must be for tmux to read it as one target. */
const isId = (value: unknown): boolean =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
const isText = (max: number) => (value: unknown): boolean => isString(value) && (value as string).length <= max

/** How each field type is checked, and how a rejection describes it. */
const FIELD_TYPES = {
  string: { ok: isString, expected: 'a string' },
  number: { ok: isNumber, expected: 'a number' },
  id: { ok: isId, expected: 'a non-negative integer' },
  input: { ok: isText(MAX_INPUT_CHARS), expected: `a string of at most ${MAX_INPUT_CHARS} characters` },
  content: { ok: isText(MAX_WRITE_CHARS), expected: `a string of at most ${MAX_WRITE_CHARS} characters` },
  'string?': { ok: (value: unknown) => value === undefined || isString(value), expected: 'a string when given' },
  'number?': { ok: (value: unknown) => value === undefined || isNumber(value), expected: 'a number when given' },
  'string|null': { ok: (value: unknown) => value === null || isString(value), expected: 'a string or null' },
} satisfies Record<string, { ok: (value: unknown) => boolean; expected: string }>

type FieldType = keyof typeof FIELD_TYPES

type MessageOf<T extends ClientMessage['type']> = Extract<ClientMessage, { type: T }>

/**
 * One row per client message type, one entry per field. A type added to
 * ClientMessage without a row here, or a row missing a field, fails to
 * compile.
 */
type Shapes = {
  [T in ClientMessage['type']]: { [K in Exclude<keyof MessageOf<T>, 'type'>]-?: FieldType }
}

const SHAPES: Shapes = {
  'terminal:input': { windowId: 'id', data: 'input' },
  'terminal:resize': { windowId: 'id', cols: 'number', rows: 'number' },
  'terminal:attach': { windowId: 'id', cols: 'number?', rows: 'number?' },
  'terminal:detach': { windowId: 'id' },
  'session:list': {},
  'session:create': { name: 'string?', cwd: 'string?' },
  'session:kill': { windowId: 'id' },
  'session:rename': { windowId: 'id', name: 'string' },
  'sessions:past': {},
  'session:revive': { agent: 'string', sessionId: 'string' },
  'files:tree': { cwd: 'string' },
  'files:read': { path: 'string' },
  'files:write': { path: 'string', content: 'content' },
  'files:watch': { cwd: 'string' },
  'files:unwatch': {},
  ping: {},
  'client:hello': { build: 'string|null' },
}

function isKnownType(type: unknown): type is ClientMessage['type'] {
  return typeof type === 'string' && Object.prototype.hasOwnProperty.call(SHAPES, type)
}

/** Check a parsed payload against SHAPES; the error names the message type. */
export function validateMessage(raw: unknown): ClientMessage {
  if (typeof raw !== 'object' || raw === null || !('type' in raw)) {
    throw new ClientError('Invalid message: missing type')
  }
  const msg = raw as Record<string, unknown>
  if (!isKnownType(msg.type)) throw new ClientError(`Invalid message: unknown type ${JSON.stringify(msg.type)}`)
  const shape: Record<string, FieldType> = SHAPES[msg.type]
  for (const [field, type] of Object.entries(shape)) {
    if (!FIELD_TYPES[type].ok(msg[field])) {
      throw new ClientError(`Invalid message: ${msg.type} requires ${field} to be ${FIELD_TYPES[type].expected}`)
    }
  }
  return msg as unknown as ClientMessage
}

/**
 * The fields of an error reply that tie it to the request it answers. Works
 * on any parsed payload, valid or not, so a rejected message still gets an
 * error the right consumer can claim.
 */
function correlation(raw: unknown): Pick<ErrorMessage, 'request' | 'windowId' | 'path'> {
  const msg = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
  const fields: Pick<ErrorMessage, 'request' | 'windowId' | 'path'> = {
    request: isKnownType(msg.type) ? msg.type : 'unknown',
  }
  if (typeof msg.windowId === 'number') fields.windowId = msg.windowId
  if (typeof msg.path === 'string') fields.path = msg.path
  return fields
}

/** A well-formed ping; anything else, ping-shaped or not, goes through the queue. */
function isPing(raw: unknown): boolean {
  return typeof raw === 'object' && raw !== null && (raw as { type?: unknown }).type === 'ping'
}

function clamp(value: number, max: number): number {
  return Math.max(1, Math.min(max, Math.round(value)))
}

// ---------------------------------------------------------------------------
// Connection handler
// ---------------------------------------------------------------------------

/** One handler per message type; a type without one fails to compile. */
type Handlers = { [T in ClientMessage['type']]: (msg: MessageOf<T>) => void | Promise<void> }

/**
 * Set up per-connection state and message dispatch for a single WebSocket
 * client. Listeners are installed synchronously: a socket that errors
 * while the welcome is still being assembled must already have someone
 * listening, or the process goes down with it.
 */
export function handleConnection(ws: WebSocket, deps: ConnectionDeps): Connection {
  const {
    remoteAddress, send, broadcast, ptySpawner, tmuxExec, pastSessions, logger, welcome, claimWindow, releaseWindow,
    releaseAllWindows, dropAttachmentsFor, userAgent, serverBuild, serverRoot, servedClientBuild,
  } = deps
  const log = scopedLog(logger, 'ws')

  /** Set by the close handler; anything still in flight stops at its next check. */
  let closed = false

  const attachments = new Map<number, Attachment>()

  const dropAttachment = (windowId: number): void => {
    const attachment = attachments.get(windowId)
    if (!attachment) return
    attachments.delete(windowId)
    if (attachment.tracker.timer) clearTimeout(attachment.tracker.timer)
    if (attachment.reflowTimer) clearTimeout(attachment.reflowTimer)
    if (attachment.drainTimer) clearInterval(attachment.drainTimer)
    attachment.pty?.kill()
  }

  /** Let go of a window: kill this connection's pty for it and give up ownership. */
  const detach = (windowId: number): void => {
    dropAttachment(windowId)
    releaseWindow(windowId)
  }

  /** Check the history once output has settled; a burst becomes one check. */
  const scheduleHistory = (windowId: number): void => {
    const tracker = attachments.get(windowId)?.tracker
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
   * the whole history again (attach). One sync per window
   * runs at a time; a request that lands mid-run is folded into a rerun so
   * messages reach the client in order.
   */
  const syncHistory = async (windowId: number, force = false): Promise<void> => {
    const tracker = attachments.get(windowId)?.tracker
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
    // The attachment can be dropped or replaced (re-attach, close) while
    // tmux answers; what came back then describes a client state that is gone.
    const stale = (): boolean => attachments.get(windowId)?.tracker !== tracker
    try {
      const state = await paneHistoryState(windowId, tmuxExec)
      if (stale()) return
      const plan = planHistoryUpdate(reset ? null : tracker.known, state)
      if (plan.kind === 'none') {
        // Only the alternate screen turns a reset into nothing: history is
        // frozen behind it, so the reset waits until it comes back.
        if (reset) tracker.resetNext = true
        return
      }
      // The size was read a tmux call ago and the pane keeps printing, so
      // the history is at least this long by the time a capture runs and
      // may be much longer. Asking for more rows than it holds is free —
      // tmux starts at the oldest row it has — while capping the ask at
      // the size we read hands back a window that starts *after* the
      // client's last line, and its lines are then lost for good. The one
      // size that must be honoured is zero: with no history at all,
      // capture-pane answers with the top row of the visible screen.
      const capture = (rows: number): Promise<string[]> =>
        state.size === 0 ? Promise.resolve([]) : captureHistoryLines(windowId, rows, tmuxExec)
      if (plan.kind === 'sync') {
        const captured = await capture(plan.count + HISTORY_TAIL)
        if (stale()) return
        const aligned = alignHistory(tracker.sentTail, captured, state.width)
        if (aligned !== null) {
          tracker.sentTail = nextTail(aligned.tail, HISTORY_TAIL)
          if (aligned.fresh.length > 0) {
            send({ type: 'terminal:history', windowId, lines: aligned.fresh, reset: false })
          }
          tracker.known = state.size
          return
        }
        // No overlap with what was sent, or no way to tell where it sits:
        // the client cannot be appended to, so fall through and start it over.
      }
      // Only the tail the client will keep. `known` still records the size
      // as it was read: it can only lag what the capture actually holds,
      // and a later sync that re-sends a line beats one that skips it.
      const lines = await capture(MAX_HISTORY_LINES)
      if (stale()) return
      tracker.sentTail = nextTail(lines, HISTORY_TAIL)
      tracker.known = state.size
      send({ type: 'terminal:history', windowId, lines, reset: true })
    } catch (err) {
      // The attach awaits its sync and reports the failure to the client;
      // a background check has no one to tell.
      if (force) throw err
      log.error('history sync error:', err)
    } finally {
      tracker.running = false
      if (tracker.dirty && !stale()) scheduleHistory(windowId)
    }
  }

  const onOutput = (attachment: Attachment, data: string): void => {
    // A killed pty can still flush a little (tmux's detach notice); that
    // belongs to an attachment the client no longer has.
    if (attachments.get(attachment.windowId) !== attachment) return
    send({ type: 'terminal:output', windowId: attachment.windowId, data })
    scheduleHistory(attachment.windowId)
    if (attachment.drainTimer || ws.bufferedAmount < BACKPRESSURE_HIGH) return
    attachment.pty?.pause()
    attachment.drainTimer = setInterval(() => {
      if (ws.bufferedAmount >= BACKPRESSURE_LOW) return
      if (attachment.drainTimer) clearInterval(attachment.drainTimer)
      attachment.drainTimer = null
      attachment.pty?.resume()
    }, BACKPRESSURE_POLL_MS)
  }

  const onExit = (attachment: Attachment): void => {
    // Our own kill (detach, handoff, close) already forgot the attachment.
    if (attachments.get(attachment.windowId) !== attachment) return
    dropAttachment(attachment.windowId)
    send({ type: 'terminal:exited', windowId: attachment.windowId })
    releaseWindow(attachment.windowId)
  }

  const attach = async (msg: MessageOf<'terminal:attach'>): Promise<void> => {
    const { windowId } = msg
    if (!attachments.has(windowId) && attachments.size >= MAX_ATTACHMENTS) {
      throw new ClientError(`Too many terminals attached on one connection (max ${MAX_ATTACHMENTS})`)
    }
    dropAttachment(windowId)
    const attachment: Attachment = {
      windowId,
      pty: null,
      tracker: { known: null, sentTail: [], timer: null, running: false, dirty: false, resetNext: false },
      reflowTimer: null,
      drainTimer: null,
    }
    attachments.set(windowId, attachment)

    // The client's scrollback is the pane's history; send all of it before
    // the pty spawns so it sits above the live screen from the first paint.
    // A window tmux no longer has fails here, rather than as a pty that
    // exits at once and is reported as the session ending.
    try {
      await syncHistory(windowId, true)
    } catch (err) {
      detach(windowId)
      throw err
    }
    // The socket may have closed, or the window been killed or taken over,
    // while tmux answered.
    if (closed || attachments.get(windowId) !== attachment) return

    claimWindow(windowId)
    try {
      attachment.pty = attachToPane(
        windowId,
        { onData: (data) => onOutput(attachment, data), onExit: () => onExit(attachment) },
        {
          cols: msg.cols === undefined ? undefined : clamp(msg.cols, MAX_COLS),
          rows: msg.rows === undefined ? undefined : clamp(msg.rows, MAX_ROWS),
        },
        ptySpawner,
      )
    } catch (err) {
      // The dispatcher reports the failure against this attach.
      detach(windowId)
      throw err
    }
  }

  // File-panel state: the directory files:read/files:write resolve
  // against (set by files:tree and files:watch) and the active watcher.
  let currentCwd: string | null = null
  let currentWatcher: Watcher | null = null

  const fileRoot = (): string => {
    if (currentCwd === null) throw new ClientError('No directory selected (send files:tree first)')
    return currentCwd
  }

  const handlers: Handlers = {
    ping: () => {
      send({ type: 'pong' })
    },
    'client:hello': async (msg) => {
      // The one log line that says which bundle a device is running.
      log.log(`hello from ${remoteAddress} build=${msg.build ?? 'none'} ua="${userAgent}"`)
      send({ type: 'server:hello', serverBuild, serverRoot, clientBuild: await servedClientBuild() })
    },
    'session:list': async () => {
      send({ type: 'session:list', windows: await listWindows(tmuxExec) })
    },
    'session:create': async (msg) => {
      broadcast({ type: 'session:created', window: await createWindow(msg.name, msg.cwd, tmuxExec) })
    },
    'session:kill': async (msg) => {
      // Attachments go first: a pty still attached would see tmux end the
      // session and report it as the pane exiting.
      dropAttachmentsFor(msg.windowId)
      await killWindow(msg.windowId, tmuxExec)
      broadcast({ type: 'session:killed', windowId: msg.windowId })
    },
    'session:rename': async (msg) => {
      await renameWindow(msg.windowId, msg.name, tmuxExec)
      broadcast({ type: 'session:renamed', windowId: msg.windowId, name: msg.name })
    },
    'sessions:past': async () => {
      // A read-only query: answered to the asker, not broadcast.
      send({ type: 'sessions:past', sessions: pastSessions ? await pastSessions.list() : [] })
    },
    'session:revive': async (msg) => {
      if (!pastSessions) throw new ClientError('No agents configured')
      const { name, cwd, command } = await pastSessions.resolve(msg.agent, msg.sessionId)
      const window = await createWindow(name, cwd, tmuxExec)
      // The name is Foray's guess from the transcript, not the user's: the
      // agent's own title takes over once it is running (mirrorTitles).
      await unmarkNamed(window.id, tmuxExec)
      await runInWindow(window.id, command, tmuxExec)
      broadcast({ type: 'session:created', window: { ...window, named: false } })
    },
    'terminal:attach': attach,
    'terminal:detach': (msg) => detach(msg.windowId),
    'terminal:input': (msg) => {
      attachments.get(msg.windowId)?.pty?.write(msg.data)
    },
    'terminal:resize': (msg) => {
      const attachment = attachments.get(msg.windowId)
      if (!attachment?.pty) return
      attachment.pty.resize(clamp(msg.cols, MAX_COLS), clamp(msg.rows, MAX_ROWS))
      // tmux reflows the history to the new width; check once the burst
      // of resizes has settled whether that moved anything.
      if (attachment.reflowTimer) clearTimeout(attachment.reflowTimer)
      attachment.reflowTimer = setTimeout(() => {
        attachment.reflowTimer = null
        void syncHistory(msg.windowId)
      }, HISTORY_REFLOW_MS)
    },
    'files:tree': async (msg) => {
      currentCwd = resolveRoot(msg.cwd)
      const { entries, truncated } = await getTree(currentCwd)
      send({ type: 'files:tree', entries, truncated })
    },
    'files:read': async (msg) => {
      send({ type: 'files:content', path: msg.path, content: await readFile(fileRoot(), msg.path) })
    },
    'files:write': async (msg) => {
      await writeFile(fileRoot(), msg.path, msg.content)
      send({ type: 'files:saved', path: msg.path })
    },
    'files:watch': (msg) => {
      const cwd = resolveRoot(msg.cwd)
      currentWatcher?.close()
      currentCwd = cwd
      const watcher = watchDir(cwd, {
        onChange: async (changedPath) => {
          try {
            send({ type: 'files:changed', path: changedPath, content: await readFile(cwd, changedPath) })
          } catch (err) {
            // Gone between the event and the read: report it as the delete it is.
            if ((err as NodeJS.ErrnoException).code === 'ENOENT') send({ type: 'files:removed', path: changedPath })
            else log.error('files:watch change handling error:', err)
          }
        },
        onRemove: (removedPath) => {
          send({ type: 'files:removed', path: removedPath })
        },
      }, { logger: log })
      currentWatcher = watcher
      // The ack is not awaited: a big directory's initial scan must not
      // hold up the terminal input queued behind it.
      void watcher.ready.then(() => {
        if (currentWatcher === watcher && !closed) send({ type: 'files:watching', cwd })
      })
    },
    'files:unwatch': () => {
      currentWatcher?.close()
      currentWatcher = null
    },
  }

  const handle = async (raw: unknown): Promise<void> => {
    if (closed) return
    try {
      const msg = validateMessage(raw)
      const handler = handlers[msg.type] as (msg: ClientMessage) => void | Promise<void>
      await handler(msg)
    } catch (err) {
      if (!(err instanceof ClientError)) log.error('message handling error:', err)
      send({ type: 'error', message: safeErrorMessage(err), ...correlation(raw) })
    }
  }

  // The per-connection queue: the welcome first, then each message after
  // the one before it has finished. `handle` never rejects, so one failing
  // message cannot stall the rest.
  let queue: Promise<void> = welcome().catch((err) => log.error('welcome failed:', err))
  ws.on('message', (data) => {
    let raw: unknown
    try {
      raw = JSON.parse(data.toString())
    } catch (err) {
      log.error('message handling error:', err)
      send({ type: 'error', message: safeErrorMessage(err), request: 'unknown' })
      return
    }
    // The ping measures the connection, not the queue: answered ahead of
    // it, so a tmux call stalled in front of it cannot look to the client
    // like a dead socket and cost it a reconnect.
    if (isPing(raw)) {
      send({ type: 'pong' })
      return
    }
    queue = queue.then(() => handle(raw))
  })

  ws.on('close', () => {
    closed = true
    log.log(`client disconnected (${remoteAddress})`)
    for (const windowId of [...attachments.keys()]) dropAttachment(windowId)
    currentWatcher?.close()
    currentWatcher = null
    // Drop this connection from ownership tracking and let everyone else
    // know the ownership snapshot changed.
    releaseAllWindows()
  })

  ws.on('error', (err) => {
    log.error('connection error:', err)
  })

  return { dropAttachment }
}
