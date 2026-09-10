// Tmux CLI wrapper, pty bridge, and server message routing tests.
//
// Run with: npx tsx --test src/server/__tests__/tmux-and-routing.test.ts

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import {
  listWindows,
  createWindow,
  killWindow,
  renameWindow,
  paneHistoryState,
  captureHistoryLines,
  applyTmuxServerOptions,
  sessionNameFor,
  tmuxSocketArgs,
  SEP,
  type TmuxExecutor,
} from '../tmux.ts'
import { ClientError } from '../errors.ts'

import {
  attachToPane,
  type PtySpawner,
  type PtyProcess,
} from '../pty-bridge.ts'

import { connect, fakeTmux, startTestServer, until, waitForType } from './helpers.ts'

/** Hostname passed to the parser; tmux initialises every pane title to this. */
const HOST = 'testhost'

/** Build one line of `tmux list-sessions -F <FORMAT>` output. */
function line(
  id: number,
  name: string,
  cwd: string,
  opts: { title?: string; command?: string; named?: boolean } = {},
): string {
  return [
    `$${id}`,
    name,
    cwd,
    opts.title ?? HOST,
    opts.command ?? 'bash',
    opts.named ? '1' : '',
  ].join(SEP)
}

/** Executor that always returns the given stdout. */
function execReturning(stdout: string): TmuxExecutor {
  return async () => ({ stdout, stderr: '' })
}

// ---------------------------------------------------------------------------
// Test 1: tmux.listWindows (lists sessions with the foray_ prefix; the
// nest_ compat fallback is covered by rename-migration.test.ts)
// ---------------------------------------------------------------------------

test('listWindows parses tmux session output into TmuxWindow[]', async () => {
  const mockExec = execReturning(
    [
      line(0, 'foray_shell', '/home/user'),
      line(1, 'foray_claude', '/home/user/project'),
      line(2, 'foray_build', '/home/user/project'),
    ].join('\n') + '\n',
  )

  const windows = await listWindows(mockExec, HOST)
  assert.equal(windows.length, 3)

  assert.deepEqual(windows[0], {
    id: 0, name: 'shell', cwd: '/home/user', title: '', command: 'bash', named: false,
  })
  assert.equal(windows[1].id, 1)
  assert.equal(windows[1].name, 'claude')
  assert.equal(windows[1].cwd, '/home/user/project')
  assert.equal(windows[2].id, 2)
  assert.equal(windows[2].name, 'build')
})

test('listWindows asks tmux for id, name, cwd, title, command and the named flag', async () => {
  let format = ''
  const mockExec: TmuxExecutor = async (_cmd, args) => {
    assert.equal(args[0], 'list-sessions')
    format = args[args.indexOf('-F') + 1]
    return { stdout: '', stderr: '' }
  }
  await listWindows(mockExec, HOST)
  assert.deepEqual(format.split(SEP), [
    '#{session_id}',
    '#{session_name}',
    '#{pane_current_path}',
    '#{pane_title}',
    '#{pane_current_command}',
    // Prefers the current named-stamp option, falling back to the legacy one.
    '#{?#{@foray_named},#{@foray_named},#{@nest_named}}',
  ])
})

test('listWindows filters out non-Foray sessions', async () => {
  const mockExec = execReturning(
    [line(0, 'foray_shell', '/root'), line(1, 'other_session', '/tmp'), line(2, 'foray_dev', '/root/project')].join('\n'),
  )

  const windows = await listWindows(mockExec, HOST)
  assert.equal(windows.length, 2)
  assert.equal(windows[0].name, 'shell')
  assert.equal(windows[1].name, 'dev')
})

test('listWindows returns [] for empty output', async () => {
  const windows = await listWindows(execReturning(''), HOST)
  assert.deepEqual(windows, [])
})

test('listWindows returns [] when tmux errors (no server running)', async () => {
  const mockExec: TmuxExecutor = async () => {
    throw new Error('no server running on /tmp/tmux-1000/default')
  }
  const windows = await listWindows(mockExec, HOST)
  assert.deepEqual(windows, [])
})

test('listWindows handles paths and titles with spaces', async () => {
  const mockExec = execReturning(
    line(5, 'foray_dev', '/home/user/my project/src', { title: 'my long title', command: 'vim' }),
  )

  const windows = await listWindows(mockExec, HOST)
  assert.equal(windows.length, 1)
  assert.equal(windows[0].id, 5)
  assert.equal(windows[0].name, 'dev')
  assert.equal(windows[0].cwd, '/home/user/my project/src')
  assert.equal(windows[0].title, 'my long title')
  assert.equal(windows[0].command, 'vim')
})

test('listWindows surfaces a title set by a running program', async () => {
  const mockExec = execReturning(
    line(1, 'foray_bash', '/root/GitHub', { title: '✳ Test session', command: 'claude' }),
  )
  const [win] = await listWindows(mockExec, HOST)
  assert.equal(win.title, '✳ Test session')
  assert.equal(win.command, 'claude')
  assert.equal(win.named, false)
})

test('listWindows blanks the title when it is just the hostname (tmux default)', async () => {
  const mockExec = execReturning(line(1, 'foray_bash', '/root', { title: HOST, command: 'claude' }))
  const [win] = await listWindows(mockExec, HOST)
  assert.equal(win.title, '')
})

test('listWindows blanks a stale title once a bare shell is in the foreground', async () => {
  // Claude set a title, then exited. tmux keeps the old title; we should not.
  const mockExec = execReturning(line(1, 'foray_bash', '/root', { title: '✳ old', command: 'bash' }))
  const [win] = await listWindows(mockExec, HOST)
  assert.equal(win.title, '')
})

test('listWindows reads the @foray_named flag', async () => {
  const mockExec = execReturning(
    line(1, 'foray_work', '/root', { title: '✳ something', command: 'claude', named: true }),
  )
  const [win] = await listWindows(mockExec, HOST)
  assert.equal(win.named, true)
  assert.equal(win.title, '✳ something', 'title is still reported; the UI decides what to show')
})

// ---------------------------------------------------------------------------
// Test 2: tmux.createWindow (creates a session)
// ---------------------------------------------------------------------------

test('createWindow creates a new tmux session and returns it', async () => {
  const calls: { cmd: string; args: string[] }[] = []

  const mockExec: TmuxExecutor = async (cmd, args) => {
    calls.push({ cmd, args })
    if (args[0] === 'new-session') {
      return { stdout: line(3, 'foray_mywindow', '/home/user') + '\n', stderr: '' }
    }
    return { stdout: '', stderr: '' }
  }

  const win = await createWindow('mywindow', '/home/user', mockExec, HOST)
  assert.deepEqual(win, {
    id: 3, name: 'mywindow', cwd: '/home/user', title: '', command: 'bash', named: true,
  })

  assert.equal(calls[0].args[0], 'new-session')
  assert.ok(calls[0].args.includes('-s'))
  assert.ok(calls[0].args.includes('foray_mywindow'))
  assert.ok(calls[0].args.includes('-c'))
  assert.ok(calls[0].args.includes('/home/user'))

  // An explicit name is stamped onto the session so it survives restarts.
  const stamp = calls.find((c) => c.args[0] === 'set' && c.args.includes('@foray_named'))
  assert.ok(stamp, 'should set @foray_named on the new session')
  assert.deepEqual(stamp!.args, ['set', '-t', 'foray_mywindow', '@foray_named', '1'])
})

test('createWindow defaults name to bash when not provided and leaves it unnamed', async () => {
  const calls: { args: string[] }[] = []

  const mockExec: TmuxExecutor = async (_cmd, args) => {
    calls.push({ args })
    if (args[0] === 'new-session') {
      return { stdout: line(1, 'foray_bash', '/tmp') + '\n', stderr: '' }
    }
    return { stdout: '', stderr: '' }
  }

  const win = await createWindow(undefined, undefined, mockExec, HOST)
  assert.equal(win.id, 1)
  assert.equal(win.name, 'bash')
  assert.equal(win.named, false)
  assert.ok(calls[0].args.includes('foray_bash'))
  const cwdIdx = calls[0].args.indexOf('-c')
  assert.equal(
    calls[0].args[cwdIdx + 1],
    os.homedir(),
    'an unspecified cwd must fall back to the home directory, not the server cwd',
  )
  assert.ok(
    !calls.some((c) => c.args.includes('@foray_named')),
    'an auto-named session must not be stamped as named',
  )
})

test('createWindow applies the extended-keys options: a session proves the server is up', async () => {
  const tmux = fakeTmux()
  await createWindow('w', undefined, tmux.exec)
  const at = (option: string): number =>
    tmux.calls.findIndex((args) => args[0] === 'set' && args[1] === '-s' && args[2] === option)
  const created = tmux.calls.findIndex((args) => args[0] === 'new-session')
  assert.ok(at('extended-keys') > created, 'extended-keys is set after the session exists')
  assert.ok(at('extended-keys-format') > created, 'extended-keys-format is set after the session exists')
})

// ---------------------------------------------------------------------------
// Test 2a: tmux.applyTmuxServerOptions
// ---------------------------------------------------------------------------

test('applyTmuxServerOptions sets extended keys and reports whether tmux took them; mouse/history-limit already match', async () => {
  const tmux = fakeTmux()
  assert.equal(await applyTmuxServerOptions(tmux.exec), true)
  assert.deepEqual(tmux.calls, [
    ['set', '-s', 'extended-keys', 'always'],
    ['set', '-s', 'extended-keys-format', 'csi-u'],
    ['show', '-g', '-v', 'mouse'],
    ['show', '-g', '-v', 'history-limit'],
  ])
  // Any failure means the options are not on, whatever the reason.
  for (const message of ['no server running on /tmp/tmux-0/default', 'lost server', 'invalid option: extended-keys']) {
    const failing: TmuxExecutor = async () => {
      throw new Error(message)
    }
    assert.equal(await applyTmuxServerOptions(failing), false, message)
  }
})

test('applyTmuxServerOptions re-asserts mouse and history-limit when a lost race left them off', async () => {
  const tmux = fakeTmux()
  tmux.serverOptions.set('mouse', 'on')
  tmux.serverOptions.set('history-limit', '2000')
  assert.equal(await applyTmuxServerOptions(tmux.exec), true)
  assert.deepEqual(tmux.calls.filter((args) => args[0] === 'set' && args[1] === '-g'), [
    ['set', '-g', 'mouse', 'off'],
    ['set', '-g', 'history-limit', '10000'],
  ])
  assert.equal(tmux.serverOptions.get('mouse'), 'off')
  assert.equal(tmux.serverOptions.get('history-limit'), '10000')
})

// scripts/foray.tmux.conf (S4) ships the same extended-keys values this
// function re-asserts, so the two copies cannot drift silently. Skipped,
// not invented, until that file exists.
test('foray.tmux.conf keeps the same extended-keys values applyTmuxServerOptions re-asserts', async (t) => {
  const confPath = path.join(import.meta.dirname, '..', '..', '..', 'scripts', 'foray.tmux.conf')
  let conf: string
  try {
    conf = await fs.readFile(confPath, 'utf-8')
  } catch {
    t.skip('scripts/foray.tmux.conf does not exist yet (S4)')
    return
  }
  assert.match(conf, /^set -s extended-keys always$/m)
  assert.match(conf, /^set -s extended-keys-format csi-u$/m)
})

test('the server sets extended keys once tmux is listed, and again after tmux restarts', async () => {
  const tmux = fakeTmux()
  // Real tmux answers everything but new-session with "no server running"
  // once its last session is gone; the fake keeps answering, so add that.
  let emptyListings = 0
  const exec: TmuxExecutor = (cmd, args) => {
    if (tmux.sessions.size === 0 && args[0] !== 'new-session') {
      if (args[0] === 'list-sessions') emptyListings++
      const message = 'no server running on /tmp/tmux-0/default'
      return Promise.reject(Object.assign(new Error(message), { stderr: message }))
    }
    return tmux.exec(cmd, args)
  }
  const extendedKeySets = (): number =>
    tmux.calls.filter((args) => args[0] === 'set' && args.includes('extended-keys')).length

  const { url, close } = await startTestServer({ tmuxExec: exec, pollIntervalMs: 10 })
  try {
    const { ws } = await connect(url)
    assert.equal(extendedKeySets(), 0, 'nothing to set while tmux is down')
    tmux.add('shell')
    await until(() => extendedKeySets() === 1, 'the options to be set once a listing shows the server')
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.equal(extendedKeySets(), 1, 'set once while the server stays up, not every poll')

    // tmux exits with its last session and comes back with a new one.
    const seenEmpty = emptyListings
    tmux.sessions.clear()
    await until(() => emptyListings > seenEmpty, 'a poll to find the server gone')
    tmux.add('shell')
    await until(() => extendedKeySets() === 2, 'the options to be set again on the new server')
    ws.close()
  } finally {
    await close()
  }
})

// ---------------------------------------------------------------------------
// Test 2b: tmux.paneHistoryState and tmux.captureHistoryLines (scrollback
// comes from tmux history; history.ts decides what to do with these)
// ---------------------------------------------------------------------------

test('paneHistoryState parses size, limit and the alternate-screen flag', async () => {
  const calls: string[][] = []
  const mockExec: TmuxExecutor = async (_cmd, args) => {
    calls.push(args)
    return { stdout: '120 2000 0\n', stderr: '' }
  }

  assert.deepEqual(await paneHistoryState(7, mockExec), { size: 120, limit: 2000, alternate: false })
  assert.equal(calls.length, 1)
  assert.equal(calls[0][0], 'display-message')
  assert.ok(calls[0].includes('$7'))
  assert.equal(calls[0][calls[0].indexOf('-F') + 1], '#{history_size} #{history_limit} #{alternate_on}')
})

test('paneHistoryState reports the alternate screen', async () => {
  const state = await paneHistoryState(7, execReturning('5 2000 1\n'))
  assert.deepEqual(state, { size: 5, limit: 2000, alternate: true })
})

test('captureHistoryLines asks for the last N history rows and splits them', async () => {
  const calls: string[][] = []
  const mockExec: TmuxExecutor = async (_cmd, args) => {
    calls.push(args)
    return { stdout: 'old 1\n\nold 3\n', stderr: '' }
  }

  // Only the trailing newline goes; a blank row mid-history is a real row.
  assert.deepEqual(await captureHistoryLines(7, 3, mockExec), ['old 1', '', 'old 3'])
  assert.equal(calls.length, 1)
  const cap = calls[0]
  assert.equal(cap[0], 'capture-pane')
  assert.ok(cap.includes('$7'))
  assert.ok(cap.includes('-e'), 'colour escapes must survive')
  const s = cap.indexOf('-S')
  assert.deepEqual(cap.slice(s, s + 4), ['-S', '-3', '-E', '-1'], 'history rows only, not the visible screen')
})

test('captureHistoryLines returns [] for a count of 0 without calling tmux', async () => {
  const mockExec: TmuxExecutor = async () => {
    throw new Error('tmux must not be called')
  }
  assert.deepEqual(await captureHistoryLines(7, 0, mockExec), [])
})

// ---------------------------------------------------------------------------
// Test 3: tmux.killWindow and tmux.renameWindow
// ---------------------------------------------------------------------------

test('killWindow calls tmux kill-session with correct target', async () => {
  let calledArgs: string[] = []

  const mockExec: TmuxExecutor = async (_cmd, args) => {
    calledArgs = args
    return { stdout: '', stderr: '' }
  }

  await killWindow(7, mockExec)
  assert.deepEqual(calledArgs, ['kill-session', '-t', '$7'])
})

test('renameWindow renames the session and marks it as explicitly named', async () => {
  const calls: string[][] = []

  const mockExec: TmuxExecutor = async (_cmd, args) => {
    calls.push(args)
    return { stdout: '', stderr: '' }
  }

  await renameWindow(4, 'new-name', mockExec)
  assert.deepEqual(calls, [
    ['rename-session', '-t', '$4', 'foray_new-name'],
    ['set', '-t', '$4', '@foray_named', '1'],
  ])
})

// ---------------------------------------------------------------------------
// Test 4: pty-bridge.attachToPane
// ---------------------------------------------------------------------------

test('attachToPane spawns tmux with correct attach command', () => {
  // A holder object rather than a `let`: TypeScript cannot see the closure
  // assign a plain variable, so it would narrow it to null and then, after
  // the assert, to never.
  const spawn = { calledWith: null as { file: string; args: string[]; options: Record<string, unknown> } | null }

  const mockSpawn: PtySpawner = (file, args, options) => {
    spawn.calledWith = { file, args, options }
    return createMockPtyProcess()
  }

  attachToPane(5, NO_EVENTS, undefined, mockSpawn)

  assert.ok(spawn.calledWith, 'spawn should have been called')
  assert.equal(spawn.calledWith.file, 'tmux')
  assert.deepEqual(spawn.calledWith.args, [...tmuxSocketArgs(), 'attach-session', '-t', '$5'])
  assert.equal(spawn.calledWith.options.name, 'xterm-256color')
  assert.equal(spawn.calledWith.options.cols, 80)
  assert.equal(spawn.calledWith.options.rows, 24)
})

test('attachToPane respects custom cols/rows', () => {
  let spawnOptions: Record<string, unknown> | null = null

  const mockSpawn: PtySpawner = (_file, _args, options) => {
    spawnOptions = options
    return createMockPtyProcess()
  }

  attachToPane(1, NO_EVENTS, { cols: 120, rows: 40 }, mockSpawn)

  assert.equal(spawnOptions!.cols, 120)
  assert.equal(spawnOptions!.rows, 40)
})

test('attachToPane forwards pty data to onData callback', () => {
  const received: string[] = []
  // Holder object for the same narrowing reason as in the spawn test above.
  const pty = { dataCallback: null as ((data: string) => void) | null }

  const mockSpawn: PtySpawner = () => {
    const proc = createMockPtyProcess()
    const origOnData = proc.onData.bind(proc)
    proc.onData = (cb: (data: string) => void) => {
      pty.dataCallback = cb
      return origOnData(cb)
    }
    return proc
  }

  attachToPane(1, { onData: (data) => received.push(data), onExit: () => {} }, undefined, mockSpawn)

  assert.ok(pty.dataCallback, 'onData should have been called')
  pty.dataCallback('hello')
  pty.dataCallback('world')
  assert.deepEqual(received, ['hello', 'world'])
})

test('attachToPane handle.write() calls pty.write()', () => {
  const written: string[] = []

  const mockSpawn: PtySpawner = () => {
    const proc = createMockPtyProcess()
    proc.write = (data: string) => {
      written.push(data)
    }
    return proc
  }

  const handle = attachToPane(1, NO_EVENTS, undefined, mockSpawn)
  handle.write('ls\n')
  handle.write('pwd\n')
  assert.deepEqual(written, ['ls\n', 'pwd\n'])
})

test('attachToPane handle.resize() calls pty.resize()', () => {
  const resizes: { cols: number; rows: number }[] = []

  const mockSpawn: PtySpawner = () => {
    const proc = createMockPtyProcess()
    proc.resize = (cols: number, rows: number) => {
      resizes.push({ cols, rows })
    }
    return proc
  }

  const handle = attachToPane(1, NO_EVENTS, undefined, mockSpawn)
  handle.resize(120, 40)
  assert.deepEqual(resizes, [{ cols: 120, rows: 40 }])
})

test('attachToPane handle.kill() calls pty.kill()', () => {
  let killed = false

  const mockSpawn: PtySpawner = () => {
    const proc = createMockPtyProcess()
    proc.kill = () => {
      killed = true
    }
    return proc
  }

  const handle = attachToPane(1, NO_EVENTS, undefined, mockSpawn)
  assert.equal(killed, false)
  handle.kill()
  assert.equal(killed, true)
})

// ---------------------------------------------------------------------------
// Test 5: Server integration — WebSocket message routing
// ---------------------------------------------------------------------------

test('server sends session:list welcome and responds to session:list', async () => {
  const { url, close, tmux } = await startTestServer()
  tmux.add('shell', { cwd: '/home/user' })
  try {
    const { ws, welcome } = await connect(url)
    assert.equal(welcome.type, 'session:list')
    assert.deepEqual(welcome.windows.map((w: any) => w.name), ['shell'])

    const reply = waitForType(ws, 'session:list')
    ws.send(JSON.stringify({ type: 'session:list' }))
    assert.deepEqual((await reply).windows, welcome.windows)

    ws.close()
  } finally {
    await close()
  }
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const NO_EVENTS = { onData: () => {}, onExit: () => {} }

function createMockPtyProcess(): PtyProcess {
  return {
    onData(_cb: (data: string) => void) {},
    onExit(_cb: (event: { exitCode: number }) => void) {},
    write(_data: string) {},
    resize(_cols: number, _rows: number) {},
    kill() {},
    pause() {},
    resume() {},
  }
}

// ---------------------------------------------------------------------------
// Test 6: one sanitiser for create and rename
// ---------------------------------------------------------------------------

// tmux rejects '.' and ':' in session names (target syntax). Both paths
// must go through one sanitiser so the same input lands on the same name.
test('create and rename produce the same tmux session name for the same input', async () => {
  const tmux = fakeTmux()
  const created = await createWindow('a.b:c', undefined, tmux.exec)
  await renameWindow(created.id, 'a.b:c', tmux.exec)

  const newSession = tmux.calls.find((args) => args[0] === 'new-session')
  const rename = tmux.calls.find((args) => args[0] === 'rename-session')
  assert.ok(newSession && rename)
  const createdName = newSession[newSession.indexOf('-s') + 1]
  const renamedName = rename[rename.length - 1]
  assert.equal(createdName, renamedName)
  assert.doesNotMatch(createdName, /[.:]/, 'tmux would reject this name')
})

test('listWindows throws for tmux failures other than a missing server', async () => {
  const mockExec: TmuxExecutor = async () => {
    throw new Error('lost server')
  }
  await assert.rejects(() => listWindows(mockExec, HOST), /lost server/)
})

test('sessionNameFor trims the name and refuses one with nothing in it', () => {
  assert.equal(sessionNameFor(' deploy '), 'foray_deploy')
  assert.equal(sessionNameFor('a.b:c'), 'foray_a-b-c')
  for (const name of ['', '   ', '\t\n']) {
    assert.throws(() => sessionNameFor(name), ClientError, JSON.stringify(name))
  }
})
