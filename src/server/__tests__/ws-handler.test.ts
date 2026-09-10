// ws-handler driven directly: the validator table, the error reply for
// every kind of failure, dispatch of each message type to its effect,
// terminal size clamps, and the shapes session ops broadcast.
//
// No server, no sockets: handleTestConnection feeds a fake socket and
// records what the handler sends, broadcasts, logs and does to its ptys.
// The suites that need a real WebSocket (ordering across sockets, handoff,
// reconnect) live in connection.test.ts and handoff.test.ts.
//
// Run with: npx tsx --test src/server/__tests__/ws-handler.test.ts

import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ClientMessage } from '../../shared/protocol.ts'
import { ClientError, safeErrorMessage } from '../errors.ts'
import { validateMessage, MAX_INPUT_CHARS, MAX_WRITE_CHARS, MAX_ATTACHMENTS } from '../ws-handler.ts'
import { tmuxSocketArgs } from '../tmux.ts'
import { fakeTmux, handleTestConnection, until, type HandledConnection, type Msg } from './helpers.ts'

// ---------------------------------------------------------------------------
// validateMessage
// ---------------------------------------------------------------------------

interface ValidationCase {
  /** Accepted as written. */
  good: Record<string, unknown>
  /**
   * Rejected, each naming the offending field; every required field with
   * the wrong type, and every optional one with a value of the wrong type.
   */
  bad: Array<{ payload: Record<string, unknown>; field: string }>
}

// Typed over the union, so a message type added without a row here fails
// to compile, the same way the handler's own table does.
const VALIDATION: Record<ClientMessage['type'], ValidationCase> = {
  'terminal:input': {
    good: { windowId: 0, data: 'x' },
    bad: [
      { payload: { windowId: '0', data: 'x' }, field: 'windowId' },
      { payload: { windowId: 0, data: 42 }, field: 'data' },
      { payload: { data: 'x' }, field: 'windowId' },
      { payload: { windowId: 0, data: 'x'.repeat(MAX_INPUT_CHARS + 1) }, field: 'data' },
      { payload: { windowId: 1e21, data: 'x' }, field: 'windowId' },
    ],
  },
  'terminal:resize': {
    good: { windowId: 0, cols: 80, rows: 24 },
    bad: [
      { payload: { windowId: 0, cols: '80', rows: 24 }, field: 'cols' },
      { payload: { windowId: 0, cols: 80, rows: null }, field: 'rows' },
      { payload: { windowId: 0, cols: NaN, rows: 24 }, field: 'cols' },
      { payload: { windowId: 0, cols: Infinity, rows: 24 }, field: 'cols' },
    ],
  },
  'terminal:attach': {
    good: { windowId: 0 },
    bad: [
      { payload: { windowId: '0' }, field: 'windowId' },
      { payload: { windowId: 1.5 }, field: 'windowId' },
      { payload: { windowId: -1 }, field: 'windowId' },
      { payload: { windowId: 0, cols: '80' }, field: 'cols' },
      { payload: { windowId: 0, rows: '24' }, field: 'rows' },
    ],
  },
  'terminal:detach': {
    good: { windowId: 3 },
    bad: [{ payload: { windowId: true }, field: 'windowId' }],
  },
  'session:list': { good: {}, bad: [] },
  'sessions:past': { good: {}, bad: [] },
  'session:revive': {
    good: { agent: 'claude', sessionId: 'abc' },
    bad: [
      { payload: { agent: 1, sessionId: 'abc' }, field: 'agent' },
      { payload: { agent: 'claude', sessionId: null }, field: 'sessionId' },
      { payload: { agent: 'claude' }, field: 'sessionId' },
    ],
  },
  'session:create': {
    good: {},
    bad: [
      { payload: { name: 42 }, field: 'name' },
      { payload: { cwd: ['/'] }, field: 'cwd' },
    ],
  },
  'session:kill': {
    good: { windowId: 1 },
    bad: [{ payload: { windowId: {} }, field: 'windowId' }],
  },
  'session:rename': {
    good: { windowId: 1, name: 'n' },
    bad: [
      { payload: { windowId: 1, name: 5 }, field: 'name' },
      { payload: { windowId: 1 }, field: 'name' },
    ],
  },
  'files:tree': { good: { cwd: '/tmp' }, bad: [{ payload: { cwd: 1 }, field: 'cwd' }] },
  'files:read': { good: { path: 'a' }, bad: [{ payload: { path: null }, field: 'path' }] },
  'files:write': {
    good: { path: 'a', content: '' },
    bad: [
      { payload: { path: 'a' }, field: 'content' },
      { payload: { path: 'a', content: 'x'.repeat(MAX_WRITE_CHARS + 1) }, field: 'content' },
      { payload: { path: 1, content: '' }, field: 'path' },
    ],
  },
  'files:watch': { good: { cwd: '/tmp' }, bad: [{ payload: {}, field: 'cwd' }] },
  'files:unwatch': { good: {}, bad: [] },
  ping: { good: {}, bad: [] },
  'client:hello': {
    good: { build: null },
    bad: [
      { payload: { build: 42 }, field: 'build' },
      { payload: {}, field: 'build' },
    ],
  },
}

test('validateMessage: every type accepts its well-formed payload and returns it typed', () => {
  for (const [type, c] of Object.entries(VALIDATION)) {
    const payload = { type, ...c.good }
    const msg = validateMessage(payload)
    assert.equal(msg.type, type)
    assert.deepEqual(msg, payload, `${type}: the payload comes back as sent`)
  }
})

test('validateMessage: a wrong-typed field is rejected with a ClientError naming the type and the field', () => {
  for (const [type, c] of Object.entries(VALIDATION)) {
    for (const { payload, field } of c.bad) {
      assert.throws(
        () => validateMessage({ type, ...payload }),
        (err: unknown) =>
          err instanceof ClientError && err.message.includes(type) && err.message.includes(field),
        `${type}: ${JSON.stringify(payload)} should be rejected naming ${field}`,
      )
    }
  }
})

test('validateMessage: optional string fields accept undefined but not null', () => {
  assert.doesNotThrow(() => validateMessage({ type: 'session:create', name: undefined }))
  assert.throws(() => validateMessage({ type: 'session:create', name: null }), ClientError)
  assert.doesNotThrow(() => validateMessage({ type: 'client:hello', build: 'abc' }))
})

test('validateMessage: unknown fields are ignored', () => {
  assert.doesNotThrow(() => validateMessage({ type: 'ping', extra: 1 }))
})

test('validateMessage: a payload without a type, a non-object, or an unknown type is rejected', () => {
  for (const raw of [{}, { windowId: 0 }, null, 42, 'ping', [], { type: 'ping!' }, { type: 7 }]) {
    assert.throws(
      () => validateMessage(raw),
      (err: unknown) => err instanceof ClientError && /^Invalid message/.test(err.message),
      `${JSON.stringify(raw)} should be rejected`,
    )
  }
  // A type on the Object prototype is not a message type.
  assert.throws(() => validateMessage({ type: 'constructor' }), ClientError)
})

// ---------------------------------------------------------------------------
// safeErrorMessage
// ---------------------------------------------------------------------------

test('safeErrorMessage: a ClientError crosses the wire as written', () => {
  assert.equal(safeErrorMessage(new ClientError('No directory selected')), 'No directory selected')
})

test('safeErrorMessage: an errno is reduced to what it means', () => {
  const withCode = (code: string): Error => Object.assign(new Error(`${code}: /secret/path`), { code })
  assert.equal(safeErrorMessage(withCode('ENOENT')), 'File or directory not found')
  assert.equal(safeErrorMessage(withCode('EACCES')), 'Permission denied')
  assert.equal(safeErrorMessage(withCode('EISDIR')), 'Path is a directory')
  assert.equal(safeErrorMessage(withCode('ENOTDIR')), 'Not a directory')
  assert.equal(safeErrorMessage(withCode('EMFILE')), 'Operation failed', 'an unmapped errno stays generic')
})

test('safeErrorMessage: anything else is generic and leaks nothing', () => {
  assert.equal(safeErrorMessage(new Error('spawn tmux ENOENT at /root/.tmux')), 'Operation failed')
  assert.equal(safeErrorMessage('a string'), 'Operation failed')
  assert.equal(safeErrorMessage(undefined), 'Operation failed')
  assert.equal(safeErrorMessage({ code: 'ENOENT' }), 'Operation failed', 'a bare object with a code is not an Error')
})

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

/**
 * Send `msg` and resolve once it has been handled: the server:hello to a
 * client:hello queued behind it. (Not a ping: that is answered ahead of
 * the queue.)
 */
async function handled(conn: HandledConnection, msg: object): Promise<void> {
  const hellos = conn.sent.filter((m) => m.type === 'server:hello').length
  conn.socket.receive(msg)
  conn.socket.receive({ type: 'client:hello', build: null })
  await until(() => conn.sent.filter((m) => m.type === 'server:hello').length > hellos, `${JSON.stringify(msg)} to be handled`)
}

/** Messages of `type` sent to the client so far. */
const sentOf = (conn: HandledConnection, type: string): Msg[] => conn.sent.filter((m) => m.type === type)

/** Attach to `windowId` and resolve once its pty exists. */
async function attached(conn: HandledConnection, windowId: number, size: object = {}): Promise<void> {
  await handled(conn, { type: 'terminal:attach', windowId, ...size })
  await until(() => conn.ptys.some((p) => p.args.includes(`$${windowId}`) && !p.killed), 'the pty to spawn')
}

test('dispatch: ping answers pong and client:hello answers server:hello', async () => {
  const conn = handleTestConnection({ serverBuild: 'srv-1', servedClientBuild: async () => 'cli-1' })
  conn.socket.receive({ type: 'ping' })
  await until(() => sentOf(conn, 'pong').length === 1, 'the pong')
  await handled(conn, { type: 'client:hello', build: 'cli-0' })
  assert.deepEqual(sentOf(conn, 'server:hello')[0], { type: 'server:hello', serverBuild: 'srv-1', clientBuild: 'cli-1' })
  conn.socket.emit('close')
})

test('dispatch: session:list answers this client only, with the windows tmux lists', async () => {
  const conn = handleTestConnection()
  conn.tmux.add('shell', { cwd: '/work' })
  await handled(conn, { type: 'session:list' })
  const [list] = sentOf(conn, 'session:list')
  assert.deepEqual(list, {
    type: 'session:list',
    windows: [{ id: 0, name: 'shell', cwd: '/work', title: '', command: 'bash', named: false }],
  })
  assert.deepEqual(conn.broadcasts, [], 'a list is a reply, not a broadcast')
  conn.socket.emit('close')
})

test('dispatch: terminal:attach claims the window, sends the history, then spawns the pty', async () => {
  const conn = handleTestConnection()
  conn.tmux.add('shell', { history: ['one', 'two'] })
  await attached(conn, 0)
  assert.deepEqual(conn.claimed, [0])
  assert.deepEqual(sentOf(conn, 'terminal:history'), [{ type: 'terminal:history', windowId: 0, lines: ['one', 'two'], reset: true }])
  assert.deepEqual(conn.ptys[0].args, [...tmuxSocketArgs(), 'attach-session', '-t', '$0'])
  conn.socket.emit('close')
})

test('dispatch: terminal:input writes to the attached pty and is dropped for an unattached window', async () => {
  const conn = handleTestConnection()
  conn.tmux.add('shell')
  await attached(conn, 0)
  await handled(conn, { type: 'terminal:input', windowId: 0, data: 'ls\r' })
  await handled(conn, { type: 'terminal:input', windowId: 9, data: 'nope' })
  assert.deepEqual(conn.ptys[0].writes, ['ls\r'])
  assert.deepEqual(sentOf(conn, 'error'), [], 'input for a window this client never attached is not an error')
  conn.socket.emit('close')
})

test('dispatch: terminal:detach kills the pty and releases the window', async () => {
  const conn = handleTestConnection()
  conn.tmux.add('shell')
  await attached(conn, 0)
  await handled(conn, { type: 'terminal:detach', windowId: 0 })
  assert.equal(conn.ptys[0].killed, true)
  assert.deepEqual(conn.releasedWindows, [0])
  await handled(conn, { type: 'terminal:input', windowId: 0, data: 'late' })
  assert.deepEqual(conn.ptys[0].writes, [], 'nothing is written after the detach')
  conn.socket.emit('close')
})

test('dispatch: the pty exiting on its own sends terminal:exited and releases the window', async () => {
  const conn = handleTestConnection()
  conn.tmux.add('shell')
  await attached(conn, 0)
  conn.ptys[0].exit(1)
  assert.deepEqual(sentOf(conn, 'terminal:exited'), [{ type: 'terminal:exited', windowId: 0 }])
  assert.deepEqual(conn.releasedWindows, [0])
  conn.socket.emit('close')
})

test('dispatch: closing the socket kills every pty and releases everything', async () => {
  const conn = handleTestConnection()
  conn.tmux.add('a')
  conn.tmux.add('b')
  await attached(conn, 0)
  await attached(conn, 1)
  conn.socket.emit('close')
  assert.deepEqual(conn.ptys.map((p) => p.killed), [true, true])
  assert.equal(conn.released, 1)
})

test('dispatch: a pty that produces output has it forwarded with its window id', async () => {
  const conn = handleTestConnection()
  conn.tmux.add('shell')
  await attached(conn, 0)
  conn.ptys[0].emit('hello')
  assert.deepEqual(sentOf(conn, 'terminal:output'), [{ type: 'terminal:output', windowId: 0, data: 'hello' }])
  conn.socket.emit('close')
})

// ---------------------------------------------------------------------------
// Size clamps
// ---------------------------------------------------------------------------

test('clamps: an attach size is rounded and held to 1..500 columns and 1..200 rows', async () => {
  const conn = handleTestConnection()
  for (const name of ['a', 'b', 'c', 'd']) conn.tmux.add(name)
  await attached(conn, 0, { cols: 9999, rows: 9999 })
  await attached(conn, 1, { cols: 0, rows: -5 })
  await attached(conn, 2, { cols: 80.6, rows: 24.4 })
  await attached(conn, 3, { cols: 500, rows: 200 })
  assert.deepEqual(conn.ptys.map(({ cols, rows }) => ({ cols, rows })), [
    { cols: 500, rows: 200 },
    { cols: 1, rows: 1 },
    { cols: 81, rows: 24 },
    { cols: 500, rows: 200 },
  ])
  conn.socket.emit('close')
})

test('clamps: a resize is held to the same bounds and ignored for a window without a pty', async () => {
  const conn = handleTestConnection()
  conn.tmux.add('shell')
  await attached(conn, 0)
  for (const [cols, rows] of [[9999, 9999], [0, 0], [501, 201], [120.4, 40.6], [1, 1]]) {
    await handled(conn, { type: 'terminal:resize', windowId: 0, cols, rows })
  }
  assert.deepEqual(conn.ptys[0].resizes, [
    { cols: 500, rows: 200 },
    { cols: 1, rows: 1 },
    { cols: 500, rows: 200 },
    { cols: 120, rows: 41 },
    { cols: 1, rows: 1 },
  ])
  await handled(conn, { type: 'terminal:resize', windowId: 7, cols: 80, rows: 24 })
  assert.deepEqual(sentOf(conn, 'error'), [], 'a resize for an unattached window is dropped, not an error')
  conn.socket.emit('close')
})

// ---------------------------------------------------------------------------
// Session ops: what everyone is told
// ---------------------------------------------------------------------------

test('session:create broadcasts the new window and stamps an explicit name', async () => {
  const conn = handleTestConnection()
  await handled(conn, { type: 'session:create', name: 'made', cwd: '/work' })
  assert.deepEqual(conn.broadcasts, [{
    type: 'session:created',
    window: { id: 0, name: 'made', cwd: '/work', title: '', command: 'bash', named: true },
  }])
  assert.equal(conn.tmux.sessions.get(0)?.named, true, 'tmux carries the named flag so it survives a restart')
  assert.deepEqual(sentOf(conn, 'error'), [])
  conn.socket.emit('close')
})

test('session:create without a name makes an unnamed "bash" session', async () => {
  const conn = handleTestConnection()
  await handled(conn, { type: 'session:create' })
  const [created] = conn.broadcasts
  assert.equal(created.type, 'session:created')
  assert.equal(created.window.name, 'bash')
  assert.equal(created.window.named, false)
  conn.socket.emit('close')
})

test('session:create and session:rename sanitise the name the same way', async () => {
  const conn = handleTestConnection()
  await handled(conn, { type: 'session:create', name: 'a.b:c' })
  const created = conn.tmux.sessions.get(0)!.name
  assert.doesNotMatch(created, /[.:]/, 'tmux would reject this name')
  // Renaming to the same raw input must land on the same tmux name: the
  // fake, like tmux, accepts a session's own name and rejects a taken one.
  await handled(conn, { type: 'session:rename', windowId: 0, name: 'a.b:c' })
  assert.deepEqual(sentOf(conn, 'error'), [])
  assert.equal(conn.tmux.sessions.get(0)?.name, created)
  conn.socket.emit('close')
})

test('session:rename broadcasts the new name and marks the session named', async () => {
  const conn = handleTestConnection()
  conn.tmux.add('shell')
  await handled(conn, { type: 'session:rename', windowId: 0, name: 'deploy' })
  assert.deepEqual(conn.broadcasts, [{ type: 'session:renamed', windowId: 0, name: 'deploy' }])
  assert.equal(conn.tmux.sessions.get(0)?.name, 'foray_deploy')
  assert.equal(conn.tmux.sessions.get(0)?.named, true)
  conn.socket.emit('close')
})

test('session:rename to an empty or blank name is refused with a message for the user', async () => {
  const conn = handleTestConnection()
  conn.tmux.add('shell')
  await handled(conn, { type: 'session:rename', windowId: 0, name: '' })
  await handled(conn, { type: 'session:rename', windowId: 0, name: '   ' })
  const refused = { type: 'error', message: 'Invalid session name', request: 'session:rename', windowId: 0 }
  assert.deepEqual(sentOf(conn, 'error'), [refused, refused])
  assert.deepEqual(conn.broadcasts, [])
  assert.equal(conn.tmux.sessions.get(0)?.name, 'nest_shell', 'the session keeps its name')
  conn.socket.emit('close')
})

test('session:kill drops the attachments, then removes the tmux session, then broadcasts', async () => {
  const tmux = fakeTmux()
  tmux.add('shell')
  tmux.add('other')
  // Whether the pty was already gone when tmux was told to kill the session.
  let ptyKilledFirst: boolean | null = null
  const conn = handleTestConnection({
    tmuxExec: (cmd, args) => {
      if (args[0] === 'kill-session') ptyKilledFirst = conn.ptys[0].killed
      return tmux.exec(cmd, args)
    },
  })
  await attached(conn, 0)
  await attached(conn, 1)
  await handled(conn, { type: 'session:kill', windowId: 0 })
  assert.deepEqual(conn.broadcasts, [{ type: 'session:killed', windowId: 0 }])
  assert.equal(tmux.sessions.has(0), false)
  assert.equal(conn.ptys[0].killed, true, 'the attachment to the killed window is gone')
  // The pty would see tmux end the session and report it as an exit; with
  // the pty gone first the client only ever hears session:killed.
  assert.equal(ptyKilledFirst, true, 'the pty is killed before tmux is asked to kill the session')
  assert.deepEqual(sentOf(conn, 'terminal:exited'), [], 'the kill is not reported as the pty exiting')
  assert.equal(conn.ptys[1].killed, false, 'the other window is untouched')
  // Nothing to type into any more.
  await handled(conn, { type: 'terminal:input', windowId: 0, data: 'late' })
  assert.deepEqual(conn.ptys[0].writes, [])
  conn.socket.emit('close')
})

test('session:kill of a window tmux does not know is reported against the request', async () => {
  const conn = handleTestConnection()
  await handled(conn, { type: 'session:kill', windowId: 42 })
  assert.deepEqual(sentOf(conn, 'error'), [
    { type: 'error', message: 'Operation failed', request: 'session:kill', windowId: 42 },
  ])
  assert.deepEqual(conn.broadcasts, [], 'no session:killed for a kill that failed')
  assert.equal(conn.errors.length, 1, 'the tmux failure is logged for the operator')
  conn.socket.emit('close')
})

// ---------------------------------------------------------------------------
// Error correlation
// ---------------------------------------------------------------------------

test('errors: a rejected payload is answered with request "unknown" plus whatever ids it carried', async () => {
  const conn = handleTestConnection()
  await handled(conn, { type: 'nope', windowId: 5, path: 'x' })
  await handled(conn, { windowId: 6 })
  assert.deepEqual(sentOf(conn, 'error'), [
    { type: 'error', message: 'Invalid message: unknown type "nope"', request: 'unknown', windowId: 5, path: 'x' },
    { type: 'error', message: 'Invalid message: missing type', request: 'unknown', windowId: 6 },
  ])
  assert.deepEqual(conn.errors, [], 'a bad client message is not an operator error')
  conn.socket.emit('close')
})

test('errors: unparseable text is answered, not fatal, and the connection goes on', async () => {
  const conn = handleTestConnection()
  conn.socket.emit('message', Buffer.from('{not json'))
  await handled(conn, { type: 'session:list' })
  const [err] = sentOf(conn, 'error')
  assert.equal(err.request, 'unknown')
  assert.equal(err.message, 'Operation failed', 'the parser\'s message is not the client\'s business')
  assert.equal(sentOf(conn, 'session:list').length, 1, 'later messages are still handled')
  conn.socket.emit('close')
})

test('errors: a wrong-typed field names the request and keeps the window id', async () => {
  const conn = handleTestConnection()
  await handled(conn, { type: 'terminal:resize', windowId: 3, cols: 'wide', rows: 24 })
  assert.deepEqual(sentOf(conn, 'error'), [{
    type: 'error',
    message: 'Invalid message: terminal:resize requires cols to be a number',
    request: 'terminal:resize',
    windowId: 3,
  }])
  conn.socket.emit('close')
})

test('errors: files:read before any files:tree is refused with the path it was about', async () => {
  const conn = handleTestConnection()
  await handled(conn, { type: 'files:read', path: 'notes.md' })
  assert.deepEqual(sentOf(conn, 'error'), [{
    type: 'error',
    message: 'No directory selected (send files:tree first)',
    request: 'files:read',
    path: 'notes.md',
  }])
  conn.socket.emit('close')
})

test('errors: a failed attach reports against the window, releases it, and leaves no attachment', async () => {
  const conn = handleTestConnection({
    ptySpawner: () => {
      throw new Error('posix_spawn failed: /usr/bin/tmux')
    },
  })
  conn.tmux.add('shell')
  await handled(conn, { type: 'terminal:attach', windowId: 0 })
  assert.deepEqual(sentOf(conn, 'error'), [
    { type: 'error', message: 'Operation failed', request: 'terminal:attach', windowId: 0 },
  ])
  assert.deepEqual(conn.claimed, [0], 'the claim happened before the spawn failed')
  assert.deepEqual(conn.releasedWindows, [0], 'and was released when it did')
  assert.equal(conn.errors.length, 1, 'the spawn failure is logged in full')
  await handled(conn, { type: 'terminal:detach', windowId: 0 })
  assert.deepEqual(conn.releasedWindows, [0, 0], 'a detach for it only releases; there is nothing to kill')
  conn.socket.emit('close')
})

test('errors: an attach to a window tmux does not have is refused before anything is spawned', async () => {
  const conn = handleTestConnection()
  conn.tmux.add('shell')
  await handled(conn, { type: 'terminal:attach', windowId: 5 })
  assert.deepEqual(sentOf(conn, 'error'), [
    { type: 'error', message: 'Session not found', request: 'terminal:attach', windowId: 5 },
  ])
  assert.deepEqual(conn.ptys, [], 'no pty is spawned for a window that is gone')
  assert.deepEqual(conn.claimed, [], 'nothing was claimed')
  assert.deepEqual(sentOf(conn, 'terminal:exited'), [], 'and the window is not reported as having ended')
  assert.deepEqual(conn.errors, [], 'a window that is gone is not an operator error')
  conn.socket.emit('close')
})

test('errors: a re-attach to a window that has since died drops the old attachment and releases it', async () => {
  const conn = handleTestConnection()
  conn.tmux.add('shell')
  await attached(conn, 0)
  conn.tmux.sessions.delete(0)
  await handled(conn, { type: 'terminal:attach', windowId: 0 })
  assert.deepEqual(sentOf(conn, 'error').map((e) => e.message), ['Session not found'])
  assert.equal(conn.ptys.length, 1, 'no second pty')
  assert.equal(conn.ptys[0].killed, true, 'the first attachment is gone')
  assert.deepEqual(conn.releasedWindows, [0], 'and its ownership with it')
  await handled(conn, { type: 'terminal:input', windowId: 0, data: 'late' })
  assert.deepEqual(conn.ptys[0].writes, [], 'nothing is written to the dead attachment')
  conn.socket.emit('close')
})

test('errors: one failing message does not stall the ones behind it', async () => {
  const conn = handleTestConnection()
  conn.socket.receive({ type: 'session:kill', windowId: 42 })
  conn.socket.receive({ type: 'files:read', path: 'x' })
  await handled(conn, { type: 'session:list' })
  assert.deepEqual(sentOf(conn, 'error').map((e) => e.request), ['session:kill', 'files:read'])
  assert.equal(sentOf(conn, 'session:list').length, 1)
  conn.socket.emit('close')
})

test('one connection cannot hold more than MAX_ATTACHMENTS terminals', async () => {
  const conn = handleTestConnection()
  for (let i = 0; i <= MAX_ATTACHMENTS; i++) conn.tmux.add(`s${i}`)
  for (let i = 0; i < MAX_ATTACHMENTS; i++) conn.socket.receive({ type: 'terminal:attach', windowId: i })
  await until(() => conn.ptys.length === MAX_ATTACHMENTS, 'every attach under the cap to spawn a pty')
  conn.socket.receive({ type: 'terminal:attach', windowId: MAX_ATTACHMENTS })
  await until(() => conn.sent.some((m) => m.type === 'error' && m.windowId === MAX_ATTACHMENTS), 'the refusal')
  assert.equal(conn.ptys.length, MAX_ATTACHMENTS, 'no pty for the one over the cap')
  assert.match(String(conn.sent.find((m) => m.type === 'error')?.message), /Too many terminals/)
  // Re-attaching a window already held is not a new one.
  conn.socket.receive({ type: 'terminal:attach', windowId: 0 })
  await until(() => conn.ptys.length === MAX_ATTACHMENTS + 1, 'the re-attach to spawn')
  conn.socket.emit('close')
})
