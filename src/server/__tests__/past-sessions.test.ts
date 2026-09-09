// Past sessions: the Claude provider's transcript parsing and scan, live
// detection, the aggregator, and session:revive end to end.
//
// Run with: npx tsx --test src/server/__tests__/past-sessions.test.ts

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { SESSION_ID_RE, claudeProvider, parseHead, parseTail } from '../agents/claude.ts'
import { argsFromEnv, providersFromEnv } from '../agents/index.ts'
import { PastSessions, shellQuote } from '../pastSessions.ts'
import { runInWindow, slugName } from '../tmux.ts'
import { ClientError } from '../errors.ts'
import { connect, fakeAgent, fakeSession, fakeTmux, startTestServer, tmpDir, waitForMessage, waitForType } from './helpers.ts'

const ID_A = '11111111-1111-4111-8111-111111111111'
const ID_B = '22222222-2222-4222-8222-222222222222'
const ID_C = '33333333-3333-4333-8333-333333333333'

const line = (obj: object): string => `${JSON.stringify(obj)}\n`
const userLine = (text: string, extra: object = {}): string =>
  line({ type: 'user', message: { role: 'user', content: text }, cwd: '/work/proj', gitBranch: 'main', isSidechain: false, ...extra })

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

test('parseHead takes cwd, branch and the opening prompt from the first user line', () => {
  const head = line({ type: 'file-history-snapshot', big: 'x'.repeat(100) })
    + line({ type: 'user', isSidechain: true, cwd: '/side', message: { role: 'user', content: 'subagent' } })
    + line({ type: 'user', cwd: '/work/proj', gitBranch: 'main', message: { role: 'user', content: [{ type: 'tool_result', content: 'ok' }] } })
    + userLine('hello there\nsecond line')
  assert.deepEqual(parseHead(head), { hasUser: true, cwd: '/work/proj', branch: 'main', prompt: 'hello there\nsecond line' })
})

test('parseHead reads a text block and ignores a partial last line', () => {
  const head = line({ type: 'user', cwd: '/w', message: { role: 'user', content: [{ type: 'text', text: '  block prompt ' }] } })
    + '{"type":"assistant","cwd":"/w","mess'
  assert.deepEqual(parseHead(head), { hasUser: true, cwd: '/w', prompt: 'block prompt' })
})

test('parseHead reports an empty session', () => {
  assert.deepEqual(parseHead(line({ type: 'mode', mode: 'x' })), { hasUser: false })
})

test('parseTail keeps the last title and last prompt', () => {
  const tail = 'ype":"assistant","cut":true}\n'
    + line({ type: 'ai-title', aiTitle: 'First title' })
    + line({ type: 'last-prompt', lastPrompt: 'old ask' })
    + line({ type: 'assistant', gitBranch: 'feature' })
    + line({ type: 'ai-title', aiTitle: ' Final title ' })
    + line({ type: 'last-prompt', lastPrompt: 'new ask' })
  assert.deepEqual(parseTail(tail), { title: 'Final title', lastPrompt: 'new ask', branch: 'feature' })
})

test('SESSION_ID_RE accepts a uuid and nothing else', () => {
  assert.ok(SESSION_ID_RE.test(ID_A))
  for (const bad of ['', 'x', `${ID_A} `, `${ID_A};rm`, 'ABCDEF12-1111-4111-8111-111111111111', '../../etc/passwd']) {
    assert.equal(SESSION_ID_RE.test(bad), false, bad)
  }
})

// ---------------------------------------------------------------------------
// Claude provider
// ---------------------------------------------------------------------------

/** A Claude data dir with three project folders' worth of transcripts. */
async function claudeDir(): Promise<string> {
  const dir = await tmpDir('nest-claude-')
  const proj = path.join(dir, 'projects', '-work-proj')
  const other = path.join(dir, 'projects', '-work-other')
  await fs.mkdir(proj, { recursive: true })
  await fs.mkdir(other, { recursive: true })
  await fs.mkdir(path.join(proj, 'subfolder'), { recursive: true })
  // A: titled, with a last prompt.
  await fs.writeFile(path.join(proj, `${ID_A}.jsonl`),
    userLine('start a') + line({ type: 'ai-title', aiTitle: 'Titled A' }) + line({ type: 'last-prompt', lastPrompt: 'latest a' }))
  // B: untitled, so the opening prompt is the title; the same uuid also
  // sits as a stub under another project dir (a moved repo).
  await fs.writeFile(path.join(proj, `${ID_B}.jsonl`), userLine('an untitled session about widgets', { cwd: '/work/b' }))
  await fs.writeFile(path.join(other, `${ID_B}.jsonl`), line({ type: 'mode', mode: 'x' }))
  // C: empty session.
  await fs.writeFile(path.join(proj, `${ID_C}.jsonl`), line({ type: 'mode', mode: 'x' }))
  // Noise: a nested transcript and a non-uuid file.
  await fs.writeFile(path.join(proj, 'subfolder', `${ID_A}.jsonl`), userLine('nested'))
  await fs.writeFile(path.join(proj, 'notes.jsonl'), userLine('not a session'))
  // Make A older than B.
  const old = new Date(Date.now() - 60 * 60 * 1000)
  await fs.utimes(path.join(proj, `${ID_A}.jsonl`), old, old)
  return dir
}

test('the Claude provider scans top-level transcripts, dedupes and skips empties', async () => {
  const dir = await claudeDir()
  try {
    const provider = claudeProvider({ dir })
    const sessions = (await provider.scan()).sort((a, b) => a.id.localeCompare(b.id))
    assert.deepEqual(sessions.map((s) => [s.id, s.title, s.lastPrompt, s.cwd, s.branch]), [
      [ID_A, 'Titled A', 'latest a', '/work/proj', 'main'],
      [ID_B, 'an untitled session about widgets', '', '/work/b', 'main'],
    ])
    assert.ok(sessions[0].lastActive < sessions[1].lastActive, 'A is older than B')
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('the Claude provider re-parses a transcript only when it changed', async () => {
  const dir = await claudeDir()
  try {
    const provider = claudeProvider({ dir })
    const first = await provider.scan()
    const again = await provider.scan()
    const a1 = first.find((s) => s.id === ID_A)
    const a2 = again.find((s) => s.id === ID_A)
    assert.equal(a1, a2, 'unchanged file: the cached object comes back')
    const file = path.join(dir, 'projects', '-work-proj', `${ID_A}.jsonl`)
    await fs.appendFile(file, line({ type: 'ai-title', aiTitle: 'Renamed A' }))
    const later = new Date(Date.now() + 5000)
    await fs.utimes(file, later, later)
    const third = await provider.scan()
    assert.equal(third.find((s) => s.id === ID_A)?.title, 'Renamed A')
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('the Claude provider counts a session live only while its pid is', async () => {
  const dir = await tmpDir('nest-claude-')
  try {
    const sessions = path.join(dir, 'sessions')
    await fs.mkdir(sessions, { recursive: true })
    await fs.writeFile(path.join(sessions, '100.json'), JSON.stringify({ pid: 100, sessionId: ID_A, tmux: 'nest_work:@6.%6' }))
    await fs.writeFile(path.join(sessions, '200.json'), JSON.stringify({ pid: 200, sessionId: ID_B }))
    await fs.writeFile(path.join(sessions, '300.json'), JSON.stringify({ pid: 300, sessionId: ID_C, tmux: 'work' }))
    await fs.writeFile(path.join(sessions, '100.key'), 'not json')
    await fs.writeFile(path.join(sessions, 'broken.json'), '{')
    const provider = claudeProvider({ dir, pidAlive: (pid) => pid !== 200 })
    assert.deepEqual(await provider.live(), [
      { id: ID_A, tmuxSession: 'nest_work', tmuxWindow: '@6' },
      { id: ID_C, tmuxSession: 'work' },
    ])
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('the Claude provider builds its resume command from the configured args', () => {
  assert.deepEqual(claudeProvider({ dir: '/nowhere' }).resumeCommand(ID_A), ['claude', '--resume', ID_A])
  assert.deepEqual(
    claudeProvider({ dir: '/nowhere', args: ['--model', 'm'] }).resumeCommand(ID_A),
    ['claude', '--model', 'm', '--resume', ID_A],
  )
})

test('a missing data dir scans and lives as empty', async () => {
  const provider = claudeProvider({ dir: '/nowhere/at/all' })
  assert.deepEqual(await provider.scan(), [])
  assert.deepEqual(await provider.live(), [])
})

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

test('providersFromEnv offers the agents whose data dir exists, or exactly NEST_AGENTS', () => {
  assert.deepEqual(providersFromEnv({}, '/home/u', () => false).map((p) => p.id), [])
  assert.deepEqual(providersFromEnv({}, '/home/u', (d) => d === '/home/u/.claude').map((p) => p.id), ['claude'])
  assert.deepEqual(providersFromEnv({ NEST_AGENTS: 'claude' }, '/home/u', () => false).map((p) => p.id), ['claude'])
  assert.throws(() => providersFromEnv({ NEST_AGENTS: 'claude,mystery' }, '/home/u', () => false), /unknown agent "mystery"/)
  assert.deepEqual(argsFromEnv({ NEST_CLAUDE_ARGS: '  --model  x ' }, 'claude'), ['--model', 'x'])
  assert.deepEqual(argsFromEnv({}, 'claude'), [])
})

// ---------------------------------------------------------------------------
// Aggregator
// ---------------------------------------------------------------------------


test('shellQuote single-quotes every element', () => {
  assert.equal(shellQuote(['claude', '--resume', ID_A]), `'claude' '--resume' '${ID_A}'`)
  assert.equal(shellQuote(["it's"]), `'it'\\''s'`)
  assert.equal(shellQuote(['$(rm -rf /)', '; ls']), `'$(rm -rf /)' '; ls'`)
})

test('PastSessions merges agents newest first and marks live rows with their nest session', async () => {
  const tmux = fakeTmux()
  // The session the agent recorded as nest_work has since been renamed;
  // its window id (@0, the fake's first session) still finds it.
  tmux.add('work-renamed')
  const a = fakeAgent(
    [fakeSession('a1', { lastActive: 10 }), fakeSession('a2', { lastActive: 30 }), fakeSession('a3', { lastActive: 5 })],
    [{ id: 'a2', tmuxSession: 'nest_work', tmuxWindow: '@0' }, { id: 'a3', tmuxSession: 'nest_gone', tmuxWindow: '@9' }],
    'alpha',
  )
  const b = fakeAgent([fakeSession('b1', { lastActive: 20 })], [{ id: 'b1', tmuxSession: 'other' }], 'beta')
  const past = new PastSessions([a, b], { tmuxExec: tmux.exec })
  assert.equal(past.multiple, true)
  const rows = await past.list()
  assert.deepEqual(rows.map((r) => [r.agent, r.id, r.live, r.liveIn]), [
    ['alpha', 'a2', true, 'work-renamed'],
    ['beta', 'b1', true, undefined],
    ['alpha', 'a1', false, undefined],
    ['alpha', 'a3', true, 'gone'],
  ])
  assert.equal(rows[0].agentLabel, 'Fake alpha')
})

test('PastSessions still lists when tmux is unavailable', async () => {
  const a = fakeAgent([fakeSession('a1')], [{ id: 'a1', tmuxSession: 'nest_x', tmuxWindow: '@1' }])
  const past = new PastSessions([a], { tmuxExec: async () => { throw new Error('boom') } })
  assert.deepEqual((await past.list()).map((r) => [r.live, r.liveIn]), [[true, 'x']])
})

test('PastSessions.resolve vets the agent, the id, existence and liveness', async () => {
  const dir = await tmpDir('nest-cwd-')
  try {
    const agent = fakeAgent(
      [fakeSession('ok', { title: 'Fix: the bug!', cwd: dir }), fakeSession('gone', { cwd: '/nowhere/x' }), fakeSession('running')],
      [{ id: 'running' }],
    )
    const past = new PastSessions([agent], { homeDir: '/home/fallback' })
    assert.deepEqual(await past.resolve('fake', 'ok'), { name: 'fix-the-bug', cwd: dir, command: `'agent' '--resume' 'ok'` })
    assert.equal((await past.resolve('fake', 'gone')).cwd, '/home/fallback')
    for (const [agentId, id, message] of [
      ['nope', 'ok', /Unknown agent/],
      ['fake', 'BAD ID; rm', /Invalid session id/],
      ['fake', 'missing', /Session not found/],
      ['fake', 'running', /already running/],
    ] as const) {
      await assert.rejects(past.resolve(agentId, id), (err: unknown) => err instanceof ClientError && message.test(err.message))
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// tmux
// ---------------------------------------------------------------------------

test('runInWindow types the command and Enter into the session', async () => {
  const tmux = fakeTmux()
  const s = tmux.add('work')
  await runInWindow(s.id, `'agent' '--resume' 'x'`, tmux.exec)
  assert.deepEqual(tmux.calls.at(-1), ['send-keys', '-t', `$${s.id}`, `'agent' '--resume' 'x'`, 'Enter'])
})

// ---------------------------------------------------------------------------
// End to end
// ---------------------------------------------------------------------------

test('session:revive creates a session in the transcript cwd, types the resume command and broadcasts it', async () => {
  const dir = await tmpDir('nest-cwd-')
  const { url, close, tmux } = await startTestServer({
    agents: [fakeAgent([fakeSession('old', { title: 'Old Work', cwd: dir })])],
  })
  try {
    const { ws } = await connect(url)
    const other = await connect(url)
    const created = waitForType(ws, 'session:created')
    const seenByOther = waitForType(other.ws, 'session:created')
    ws.send(JSON.stringify({ type: 'session:revive', agent: 'fake', sessionId: 'old' }))
    const msg = await created
    assert.equal(msg.window.name, 'old-work')
    assert.equal(msg.window.cwd, dir)
    // Nest's guess at a name, not the user's: the agent's title will replace it.
    assert.equal(msg.window.named, false)
    assert.equal(tmux.sessions.get(msg.window.id)?.named, false)
    assert.deepEqual((await seenByOther).window, msg.window, 'every client learns of the new session')
    const typed = tmux.calls.find((c) => c[0] === 'send-keys')
    assert.deepEqual(typed, ['send-keys', '-t', `$${msg.window.id}`, `'agent' '--resume' 'old'`, 'Enter'])
    ws.close()
    other.ws.close()
  } finally {
    await close()
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('session:revive of a bad or live session answers an error naming the request', async () => {
  const { url, close, tmux } = await startTestServer({
    agents: [fakeAgent([fakeSession('busy')], [{ id: 'busy' }])],
  })
  try {
    const { ws } = await connect(url)
    for (const [sessionId, pattern] of [['; rm -rf /', /Invalid session id/], ['busy', /already running/]] as const) {
      const error = waitForMessage(ws, (m) => m.type === 'error' || m.type === 'session:created')
      ws.send(JSON.stringify({ type: 'session:revive', agent: 'fake', sessionId }))
      const err = await error
      assert.equal(err.type, 'error')
      assert.equal(err.request, 'session:revive')
      assert.match(String(err.message), pattern)
    }
    assert.equal(tmux.calls.some((c) => c[0] === 'new-session' || c[0] === 'send-keys'), false, 'nothing was created or typed')
    ws.close()
  } finally {
    await close()
  }
})

test('sessions:past answers the asker with the merged list', async () => {
  const { url, close } = await startTestServer({
    agents: [fakeAgent([fakeSession('one', { lastActive: 5 }), fakeSession('two', { lastActive: 9 })])],
  })
  try {
    const { ws } = await connect(url)
    const reply = waitForType(ws, 'sessions:past')
    ws.send(JSON.stringify({ type: 'sessions:past' }))
    const msg = await reply
    assert.deepEqual(msg.sessions.map((s: { id: string }) => s.id), ['two', 'one'])
    assert.equal(msg.sessions[0].live, false)
    ws.close()
  } finally {
    await close()
  }
})
