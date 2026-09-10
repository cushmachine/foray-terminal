// Shared harness for the unit suites that start a server.
//
// `startTestServer` is hermetic: tmux is an in-memory session table and
// ptys are recorders, so a suite never touches this machine's tmux server
// (whose sessions are someone's live shells) and needs no tmux binary at
// all. The e2e suites exist to drive real tmux; they call `startServer`
// themselves and share only the socket helpers below.

import fs from 'node:fs/promises'
import type http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import type { WebSocket as ServerSocket } from 'ws'
import { startServer, type ServerOptions } from '../index.ts'
import { SEP, type TmuxExecutor } from '../tmux.ts'
import type { PtyProcess, PtySpawner } from '../pty-bridge.ts'
import { handleConnection, type ConnectionDeps } from '../ws-handler.ts'
import type { Logger } from '../log.ts'
import type { AgentProvider, AgentSession, LiveSession } from '../agents/types.ts'

/** The token every startTestServer instance accepts; connect() presents it. */
export const TEST_TOKEN = 'test-token-0123456789abcdef'

/** A parsed protocol message; the fields beyond `type` are whatever it carries. */
export type Msg = { type: string } & Record<string, any>

/** A fresh temp directory; the caller removes it. */
export function tmpDir(prefix = 'foray-test-'): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix))
}

/** Poll `condition` until it holds; rejects naming `what` after `timeoutMs`. */
export async function until(
  condition: () => boolean,
  what = 'the condition',
  timeoutMs = 2000,
  intervalMs = 5,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
}

// ---------------------------------------------------------------------------
// Fake tmux
// ---------------------------------------------------------------------------

export interface FakeSession {
  id: number
  /** Full tmux session name, nest_ prefix included. */
  name: string
  cwd: string
  title: string
  command: string
  named: boolean
  /** Scrollback rows, oldest first. */
  history: string[]
  /** Indexes of rows tmux soft-wrapped, so `capture-pane -J` joins each with the row after it. */
  wrapped: number[]
  alternate: boolean
}

export interface FakeTmux {
  exec: TmuxExecutor
  sessions: Map<number, FakeSession>
  /** Every argv handed to tmux, oldest first. */
  calls: string[][]
  /** Global tmux options (`set -g`/`show -g`), seeded with the values Foray wants. */
  serverOptions: Map<string, string>
  /** Add a Foray session as `tmux new-session` would; ids count up from 0. */
  add(name: string, overrides?: Partial<Omit<FakeSession, 'id' | 'name'>>): FakeSession
}

// Only ever written by tmux.ts's own stamps; a legacy '@nest_named' session
// is a read-only fallback contract covered separately (rename-migration.test.ts).
const NAMED_OPTION = '@foray_named'

/** An in-memory tmux that understands the subset of commands tmux.ts issues. */
export function fakeTmux(): FakeTmux {
  const sessions = new Map<number, FakeSession>()
  const calls: string[][] = []
  // Matches applyTmuxServerOptions' desired values, so a plain fakeTmux()
  // starts already correct and tests only see a `set -g` when they mean to.
  const serverOptions = new Map<string, string>([['mouse', 'off'], ['history-limit', '10000']])
  let nextId = 0

  const makeSession = (name: string, overrides: Partial<Omit<FakeSession, 'id' | 'name'>> = {}): FakeSession => ({
    id: nextId++,
    name,
    cwd: os.homedir(),
    title: '',
    command: 'bash',
    named: false,
    history: [],
    wrapped: [],
    alternate: false,
    ...overrides,
  })

  const add: FakeTmux['add'] = (name, overrides = {}) => {
    const session = makeSession(`nest_${name}`, overrides)
    sessions.set(session.id, session)
    return session
  }

  // Same field order as tmux.ts's FORMAT; the -F argument is not interpreted.
  const line = (s: FakeSession): string =>
    [`$${s.id}`, s.name, s.cwd, s.title, s.command, s.named ? '1' : ''].join(SEP)
  const ok = (stdout = ''): { stdout: string; stderr: string } => ({ stdout, stderr: '' })
  const fail = (message: string): never => {
    throw Object.assign(new Error(message), { stderr: message })
  }
  const arg = (args: string[], flag: string): string | undefined => {
    const i = args.indexOf(flag)
    return i === -1 ? undefined : args[i + 1]
  }
  const target = (args: string[]): FakeSession => {
    const t = arg(args, '-t') ?? ''
    const byId = /^\$(\d+)$/.exec(t)
    const found = byId
      ? sessions.get(Number(byId[1]))
      : [...sessions.values()].find((s) => s.name === t)
    return found ?? fail(`can't find session: ${t}`)
  }

  const exec: TmuxExecutor = async (_cmd, args) => {
    calls.push(args)
    switch (args[0]) {
      case 'list-sessions':
        return ok([...sessions.values()].map((s) => `${line(s)}\n`).join(''))
      case 'new-session': {
        // The full name (whatever prefix the caller used) is already what
        // tmux.ts wants stored; unlike add(), this does not prepend one.
        const name = arg(args, '-s') ?? ''
        if ([...sessions.values()].some((s) => s.name === name)) fail(`duplicate session: ${name}`)
        const session = makeSession(name, { cwd: arg(args, '-c') ?? os.homedir() })
        sessions.set(session.id, session)
        return ok(`${line(session)}\n`)
      }
      case 'kill-session':
        sessions.delete(target(args).id)
        return ok()
      case 'rename-session': {
        // As tmux does: its own name is fine, anyone else's is a duplicate.
        const name = args[args.length - 1]
        const s = target(args)
        if ([...sessions.values()].some((other) => other !== s && other.name === name)) fail(`duplicate session: ${name}`)
        s.name = name
        return ok()
      }
      case 'list-windows':
        // One window per fake session; its id is the session's.
        return ok([...sessions.values()].map((s) => `@${s.id}${SEP}${s.name}\n`).join(''))
      case 'send-keys':
        // Recorded in `calls`; the fake pane runs nothing.
        target(args)
        return ok()
      case 'set':
        // Server options (-s) and `status off` change nothing observable
        // here, except the global (-g) ones applyTmuxServerOptions reads back.
        if (args.includes(NAMED_OPTION)) target(args).named = !args.includes('-u')
        else if (args[1] === '-g') serverOptions.set(args[2], args[3])
        return ok()
      case 'show': {
        // show -g -v <option>: the value of a global tmux option.
        const option = args[args.length - 1]
        return ok(`${serverOptions.get(option) ?? ''}\n`)
      }
      case 'display-message': {
        const s = target(args)
        return ok(`${s.history.length} 2000 ${s.alternate ? 1 : 0}\n`)
      }
      case 'capture-pane': {
        const s = target(args)
        const count = -Number(arg(args, '-S'))
        const from = Math.max(0, s.history.length - count)
        const wrapped = new Set(s.wrapped)
        const lines: string[] = []
        for (let i = from; i < s.history.length; i++) {
          // tmux joins a wrapped row with the next only within the range it
          // captures; the last row still gets its newline.
          const join = args.includes('-J') && i > from && wrapped.has(i - 1)
          if (join) lines[lines.length - 1] += s.history[i]
          else lines.push(s.history[i])
        }
        return ok(lines.map((row) => `${row}\n`).join(''))
      }
      default:
        return fail(`unknown command: ${args[0]}`)
    }
  }

  return { exec, sessions, calls, serverOptions, add }
}

// ---------------------------------------------------------------------------
// Fake agent
// ---------------------------------------------------------------------------

/** A past session of the fake agent with sensible defaults. */
export function fakeSession(id: string, overrides: Partial<AgentSession> = {}): AgentSession {
  return { id, title: `Session ${id}`, lastPrompt: '', cwd: os.homedir(), branch: '', lastActive: 1000, ...overrides }
}

/**
 * An agent whose sessions are the given lists and whose ids are short
 * words. Its resume command is `agent --resume <id>`.
 */
export function fakeAgent(
  sessions: AgentSession[] = [],
  live: LiveSession[] = [],
  id = 'fake',
): AgentProvider {
  return {
    id,
    label: `Fake ${id}`,
    isSessionId: (candidate) => /^[a-z0-9-]{1,32}$/.test(candidate),
    scan: async () => sessions,
    live: async () => live,
    resumeCommand: (session) => ['agent', '--resume', session],
  }
}

// ---------------------------------------------------------------------------
// Fake pty
// ---------------------------------------------------------------------------

export interface FakePty {
  file: string
  args: string[]
  cols: number
  rows: number
  writes: string[]
  resizes: Array<{ cols: number; rows: number }>
  killed: boolean
  /** How often the server asked the pty to stop reading (backpressure). */
  pauses: number
  /** How often the server asked it to read again. */
  resumes: number
  /** Deliver output as if the pane printed it. */
  emit(data: string): void
  /** End the pty as if `tmux attach` exited with `code`. */
  exit(code: number): void
}

/** A spawner whose ptys record what the server does to them. */
export function fakePtySpawner(): { spawner: PtySpawner; ptys: FakePty[] } {
  const ptys: FakePty[] = []
  const spawner: PtySpawner = (file, args, options) => {
    let onData: (data: string) => void = () => {}
    let onExit: (event: { exitCode: number }) => void = () => {}
    const pty: FakePty = {
      file,
      args,
      cols: options.cols,
      rows: options.rows,
      writes: [],
      resizes: [],
      killed: false,
      pauses: 0,
      resumes: 0,
      emit: (data) => onData(data),
      exit: (exitCode) => onExit({ exitCode }),
    }
    ptys.push(pty)
    const proc: PtyProcess = {
      onData: (cb) => {
        onData = cb
      },
      onExit: (cb) => {
        onExit = cb
      },
      write: (data) => {
        pty.writes.push(data)
      },
      resize: (cols, rows) => {
        pty.resizes.push({ cols, rows })
      },
      kill: () => {
        pty.killed = true
      },
      pause: () => {
        pty.pauses++
      },
      resume: () => {
        pty.resumes++
      },
    }
    return proc
  }
  return { spawner, ptys }
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

export interface TestServer {
  url: string
  server: http.Server
  close: () => Promise<void>
  /** The fake tmux behind this server; seed sessions with `tmux.add()`. */
  tmux: FakeTmux
  /** Every pty the server spawned, in order. */
  ptys: FakePty[]
}

/**
 * Start a server on a free port with fake tmux, fake ptys and no logging.
 * `options` override those defaults (a suite that passes its own
 * `tmuxExec` will not see its calls in the returned `tmux`).
 */
export async function startTestServer(options: ServerOptions = {}): Promise<TestServer> {
  const tmux = fakeTmux()
  const { spawner, ptys } = fakePtySpawner()
  const started = await startServer(0, {
    tmuxExec: tmux.exec,
    ptySpawner: spawner,
    quiet: true,
    // Never this machine's own transcripts; a suite injects its own provider.
    agents: [],
    // Never this machine's token file; the suites log in with TEST_TOKEN.
    auth: { token: TEST_TOKEN },
    ...options,
  })
  return { url: started.url, server: started.server, close: started.close, tmux, ptys }
}

// ---------------------------------------------------------------------------
// Direct ws-handler harness
// ---------------------------------------------------------------------------

/** Stand-in for the server-side `ws` socket handleConnection listens on. */
export interface FakeSocket extends EventEmitter {
  /** Bytes queued on the socket, as the real `ws` reports them; tests set it. */
  bufferedAmount: number
  /** Deliver a client message as if it arrived on the wire. */
  receive(msg: object): void
}

export interface HandledConnection {
  socket: FakeSocket
  /** Messages sent to this client, in order. */
  sent: Msg[]
  /** Messages broadcast to every client, in order. */
  broadcasts: Msg[]
  /** Arguments of every logger.error call. */
  errors: unknown[][]
  tmux: FakeTmux
  ptys: FakePty[]
  /** Window ids handed to claimWindow, in order. */
  claimed: number[]
  /** Window ids handed to releaseWindow, in order. */
  releasedWindows: number[]
  /** How often releaseAllWindows was called. */
  released: number
}

/**
 * Run handleConnection against a fake socket, fake tmux and recording
 * ptys, so a suite can drive one connection's handler directly and see
 * what it sends, logs and does to its ptys. Ownership callbacks only
 * record; there is no other connection to hand off to.
 */
export function handleTestConnection(overrides: Partial<ConnectionDeps> = {}): HandledConnection {
  const tmux = fakeTmux()
  const { spawner, ptys } = fakePtySpawner()
  const sent: Msg[] = []
  const broadcasts: Msg[] = []
  const errors: unknown[][] = []
  const claimed: number[] = []
  const emitter = new EventEmitter()
  const socket: FakeSocket = Object.assign(emitter, {
    bufferedAmount: 0,
    receive: (msg: object) => {
      emitter.emit('message', Buffer.from(JSON.stringify(msg)))
    },
  })
  const logger: Logger = {
    log: () => {},
    error: (...args) => {
      errors.push(args)
    },
  }
  const conn: HandledConnection = {
    socket, sent, broadcasts, errors, tmux, ptys, claimed, releasedWindows: [], released: 0,
  }
  const connection = handleConnection(socket as unknown as ServerSocket, {
    remoteAddress: 'test',
    send: (msg) => {
      sent.push(msg as Msg)
    },
    broadcast: (msg) => {
      broadcasts.push(msg as Msg)
    },
    ptySpawner: spawner,
    tmuxExec: tmux.exec,
    logger,
    welcome: async () => {},
    claimWindow: (windowId) => {
      claimed.push(windowId)
    },
    releaseWindow: (windowId) => {
      conn.releasedWindows.push(windowId)
    },
    releaseAllWindows: () => {
      conn.released++
    },
    // This is the only connection, so "every connection" is this one.
    dropAttachmentsFor: (windowId) => connection.dropAttachment(windowId),
    userAgent: 'test',
    serverBuild: 'test',
    servedClientBuild: async () => null,
    ...overrides,
  })
  return conn
}

// ---------------------------------------------------------------------------
// Sockets
// ---------------------------------------------------------------------------

/** The WebSocket endpoint for a server's HTTP url. */
export function wsUrl(url: string): string {
  return `${url.replace(/^http/, 'ws')}/ws`
}

/** The next message satisfying `predicate`; other messages are left alone. */
export function waitForMessage(
  ws: WebSocket,
  predicate: (msg: Msg) => boolean,
  timeoutMs = 5000,
  what = 'a matching message',
): Promise<Msg> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.removeEventListener('message', handler)
      reject(new Error(`timed out waiting for ${what}`))
    }, timeoutMs)
    const handler = (event: MessageEvent): void => {
      const msg = JSON.parse(String(event.data)) as Msg
      if (!predicate(msg)) return
      clearTimeout(timer)
      ws.removeEventListener('message', handler)
      resolve(msg)
    }
    ws.addEventListener('message', handler)
  })
}

/** The next message of `type`. */
export function waitForType(ws: WebSocket, type: string, timeoutMs = 5000): Promise<Msg> {
  return waitForMessage(ws, (m) => m.type === type, timeoutMs, `a "${type}" message`)
}

/** The next message of `type`, failing fast if the server answers with an error instead. */
export async function waitForTypeOrError(ws: WebSocket, type: string, timeoutMs = 10_000): Promise<Msg> {
  const msg = await waitForMessage(
    ws,
    (m) => m.type === type || m.type === 'error',
    timeoutMs,
    `a "${type}" message`,
  )
  if (msg.type === 'error') throw new Error(`expected ${type} but the server sent an error: ${msg.message}`)
  return msg
}

/** Accumulate terminal:output for `windowId` until it contains `needle`; on timeout, show what arrived. */
export function waitForOutput(ws: WebSocket, windowId: number, needle: string, timeoutMs = 10_000): Promise<string> {
  return new Promise((resolve, reject) => {
    let seen = ''
    const timer = setTimeout(() => {
      ws.removeEventListener('message', handler)
      reject(new Error(`timed out waiting for ${JSON.stringify(needle)}; output so far: ${JSON.stringify(seen)}`))
    }, timeoutMs)
    const handler = (event: MessageEvent): void => {
      const msg = JSON.parse(String(event.data)) as Msg
      if (msg.type !== 'terminal:output' || msg.windowId !== windowId) return
      seen += String(msg.data)
      if (!seen.includes(needle)) return
      clearTimeout(timer)
      ws.removeEventListener('message', handler)
      resolve(seen)
    }
    ws.addEventListener('message', handler)
  })
}

/**
 * Resolve once everything sent on `ws` before this call has been handled.
 * The connection answers in order, so the server:hello to a client:hello
 * queued last proves the rest is done. A ping would not do: it is answered
 * ahead of the queue.
 */
export async function settled(ws: WebSocket): Promise<void> {
  const hello = waitForType(ws, 'server:hello')
  ws.send(JSON.stringify({ type: 'client:hello', build: null }))
  await hello
}

/** Connect to a server and resolve once its welcome (session:list) has arrived. */
export async function connect(
  url: string,
  timeoutMs = 5000,
  headers: Record<string, string> = { authorization: `Bearer ${TEST_TOKEN}` },
): Promise<{ ws: WebSocket; welcome: Msg }> {
  // Node's WebSocket takes extra request headers, which is how a script
  // (this one) authenticates without logging in for a cookie.
  const ws = new WebSocket(wsUrl(url), { headers } as unknown as string[])
  const welcome = waitForType(ws, 'session:list', timeoutMs)
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener('open', () => resolve(), { once: true })
    ws.addEventListener('error', () => reject(new Error(`could not connect to ${url}`)), { once: true })
  })
  return { ws, welcome: await welcome }
}
