// Version handshake, server side: client:hello is answered with server:hello.
//
// Run with: npm run test:handshake

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { WebSocket as WsClient } from 'ws'
import { startServer } from '../index.ts'
import { describeCheckout, readServedClientBuild } from '../build.ts'

type Msg = { type: string; [key: string]: unknown }

/** Connect, wait for the welcome, then resolve with a way to await the next message of a type. */
async function connect(url: string): Promise<{ ws: WsClient; next: (type: string) => Promise<Msg> }> {
  const ws = new WsClient(url.replace(/^http/, 'ws') + '/ws')
  const next = (type: string): Promise<Msg> =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out waiting for ${type}`)), 5000)
      const onMessage = (data: unknown): void => {
        const msg = JSON.parse(String(data)) as Msg
        if (msg.type !== type) return
        clearTimeout(timer)
        ws.off('message', onMessage)
        resolve(msg)
      }
      ws.on('message', onMessage)
    })
  const welcome = next('session:list')
  await new Promise<void>((resolve, reject) => {
    ws.once('open', resolve)
    ws.once('error', reject)
  })
  await welcome
  return { ws, next }
}

test('client:hello is answered with server:hello carrying a server build', async () => {
  const { url, close } = await startServer(0)
  try {
    const { ws, next } = await connect(url)
    const reply = next('server:hello')
    ws.send(JSON.stringify({ type: 'client:hello', build: 'test0000.abc' }))
    const hello = await reply
    assert.equal(typeof hello.serverBuild, 'string')
    assert.ok((hello.serverBuild as string).length > 0)
    assert.ok(hello.clientBuild === null || typeof hello.clientBuild === 'string')
    ws.close()
  } finally {
    await close()
  }
})

test('client:hello with a non-string build is rejected as an invalid message', async () => {
  const { url, close } = await startServer(0)
  try {
    const { ws, next } = await connect(url)
    const reply = next('error')
    ws.send(JSON.stringify({ type: 'client:hello', build: 5 }))
    const err = await reply
    assert.ok(String(err.message).startsWith('Invalid message'), String(err.message))
    ws.close()
  } finally {
    await close()
  }
})

test('describeCheckout reports a short sha (optionally -dirty) in a repo, unknown outside one', async () => {
  const here = describeCheckout()
  assert.match(here, /^[0-9a-f]{7,}(-dirty)?$/)
  const empty = await fs.mkdtemp(path.join(os.tmpdir(), 'nest-nogit-'))
  try {
    assert.equal(describeCheckout(empty), 'unknown')
  } finally {
    await fs.rm(empty, { recursive: true, force: true })
  }
})

test('readServedClientBuild reads the stamped id from dist/index.html, null when absent', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nest-dist-'))
  try {
    assert.equal(await readServedClientBuild(root), null)
    await fs.writeFile(path.join(root, 'index.html'), '<html><head><meta name="nest-build" content="abc1234.k1"></head></html>')
    assert.equal(await readServedClientBuild(root), 'abc1234.k1')
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

// A page that reconnects sends terminal:attach and client:hello the moment
// the socket opens, before the server has finished the welcome's tmux round
// trip. Those messages must be handled, not dropped.
test('a message sent the instant the socket opens is still answered', async () => {
  const { url, close } = await startServer(0)
  try {
    const ws = new WsClient(url.replace(/^http/, 'ws') + '/ws')
    const types: string[] = []
    const hello = new Promise<Msg>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no server:hello; got ${types.join(',') || 'nothing'}`)), 5000)
      ws.on('message', (data) => {
        const msg = JSON.parse(String(data)) as Msg
        types.push(msg.type)
        if (msg.type === 'server:hello') {
          clearTimeout(timer)
          resolve(msg)
        }
      })
    })
    await new Promise<void>((resolve, reject) => {
      ws.once('open', resolve)
      ws.once('error', reject)
    })
    ws.send(JSON.stringify({ type: 'client:hello', build: 'test0000.abc' }))
    const reply = await hello
    assert.equal(typeof reply.serverBuild, 'string')
    // The welcome still comes first.
    assert.equal(types[0], 'session:list')
    ws.close()
  } finally {
    await close()
  }
})
