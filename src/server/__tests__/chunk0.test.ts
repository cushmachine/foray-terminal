// Chunk 0 tests: shared protocol types + server scaffolding.
//
// Run with: npm run test:chunk0
// (executed directly via `tsx`, using node's built-in test runner)

import { test } from 'node:test'
import assert from 'node:assert/strict'
import type {
  ClientMessage,
  ServerMessage,
  TmuxWindow,
  FileNode,
} from '../../shared/protocol.ts'
import { startServer } from '../index.ts'

test('protocol types compile and assign correctly', () => {
  const window: TmuxWindow = {
    id: 1, name: 'main', cwd: '/home/user', title: '', command: 'bash', named: false,
  }
  assert.equal(window.id, 1)
  assert.equal(window.name, 'main')
  assert.equal(window.cwd, '/home/user')

  const file: FileNode = {
    name: 'src',
    path: '/home/user/src',
    type: 'dir',
    children: [{ name: 'index.ts', path: '/home/user/src/index.ts', type: 'file' }],
  }
  assert.equal(file.type, 'dir')
  assert.equal(file.children?.[0].type, 'file')

  const clientMessages: ClientMessage[] = [
    { type: 'terminal:input', windowId: 1, data: 'ls\n' },
    { type: 'terminal:resize', windowId: 1, cols: 80, rows: 24 },
    { type: 'terminal:attach', windowId: 1 },
    { type: 'session:list' },
    { type: 'session:create', name: 'dev', cwd: '/home/user' },
    { type: 'session:create' },
    { type: 'session:kill', windowId: 1 },
    { type: 'session:rename', windowId: 1, name: 'renamed' },
    { type: 'files:tree', cwd: '/home/user' },
    { type: 'files:read', path: '/home/user/foo.txt' },
    { type: 'files:write', path: '/home/user/foo.txt', content: 'hello' },
    { type: 'files:watch', cwd: '/home/user' },
    { type: 'files:unwatch' },
  ]
  assert.equal(clientMessages.length, 13)
  assert.equal(clientMessages[0].type, 'terminal:input')

  const serverMessages: ServerMessage[] = [
    { type: 'terminal:output', windowId: 1, data: 'output\n' },
    { type: 'session:list', windows: [window] },
    { type: 'session:created', window },
    { type: 'session:killed', windowId: 1 },
    { type: 'session:renamed', windowId: 1, name: 'renamed' },
    { type: 'files:tree', entries: [file] },
    { type: 'files:content', path: '/home/user/foo.txt', content: 'hello' },
    { type: 'files:saved', path: '/home/user/foo.txt' },
    { type: 'files:changed', path: '/home/user/foo.txt', content: 'hello2' },
    { type: 'error', message: 'oops' },
  ]
  assert.equal(serverMessages.length, 10)
  assert.equal(serverMessages[1].type, 'session:list')

  // Discriminated union narrowing works.
  const msg: ServerMessage = { type: 'session:list', windows: [] }
  if (msg.type === 'session:list') {
    assert.deepEqual(msg.windows, [])
  } else {
    assert.fail('expected session:list')
  }
})

test('server starts and responds to health check', async () => {
  const { server, url, close } = await startServer(0)
  try {
    const res = await fetch(`${url}/health`)
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.deepEqual(body, { status: 'ok' })
  } finally {
    await close()
    assert.equal(server.listening, false)
  }
})

test('WebSocket connection receives a welcome message', async () => {
  const { url, close } = await startServer(0)
  try {
    const wsUrl = url.replace(/^http/, 'ws') + '/ws'
    const ws = new WebSocket(wsUrl)

    const firstMessage = await new Promise<unknown>((resolve, reject) => {
      ws.addEventListener('message', (event) => {
        resolve(JSON.parse(event.data.toString()))
      })
      ws.addEventListener('error', reject)
    })

    // The welcome lists whatever Nest sessions tmux has on this machine, so
    // assert the shape rather than an empty list.
    assert.equal((firstMessage as any).type, 'session:list')
    assert.ok(Array.isArray((firstMessage as any).windows))
    ws.close()
  } finally {
    await close()
  }
})
