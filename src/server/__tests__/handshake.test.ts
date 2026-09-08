// Version handshake, server side: client:hello is answered with server:hello.
//
// Run with: npx tsx --test src/server/__tests__/handshake.test.ts

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { describeCheckout, readServedClientBuild } from '../build.ts'
import { connect, startTestServer, tmpDir, waitForType } from './helpers.ts'

test('client:hello is answered with server:hello carrying a server build', async () => {
  const { url, close } = await startTestServer()
  try {
    const { ws } = await connect(url)
    const reply = waitForType(ws, 'server:hello')
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
  const { url, close } = await startTestServer()
  try {
    const { ws } = await connect(url)
    const reply = waitForType(ws, 'error')
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
  const empty = await tmpDir('nest-nogit-')
  try {
    assert.equal(describeCheckout(empty), 'unknown')
  } finally {
    await fs.rm(empty, { recursive: true, force: true })
  }
})

test('readServedClientBuild reads the stamped id from dist/index.html, null when absent', async () => {
  const root = await tmpDir('nest-dist-')
  try {
    assert.equal(await readServedClientBuild(root), null)
    await fs.writeFile(path.join(root, 'index.html'), '<html><head><meta name="nest-build" content="abc1234.k1"></head></html>')
    assert.equal(await readServedClientBuild(root), 'abc1234.k1')
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})
