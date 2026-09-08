// Server scaffolding: the health check and the WebSocket welcome.
//
// Run with: npx tsx --test src/server/__tests__/protocol.test.ts

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { connect, startTestServer } from './helpers.ts'

test('server starts and responds to health check', async () => {
  const { server, url, close } = await startTestServer()
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

test('WebSocket connection receives the session list as its welcome', async () => {
  const { url, close, tmux } = await startTestServer()
  tmux.add('shell', { cwd: '/home/user' })
  try {
    const { ws, welcome } = await connect(url)
    assert.deepEqual(welcome, {
      type: 'session:list',
      windows: [{ id: 0, name: 'shell', cwd: '/home/user', title: '', command: 'bash', named: false }],
    })
    ws.close()
  } finally {
    await close()
  }
})
