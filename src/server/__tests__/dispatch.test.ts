// Message validation and error replies.
//
// Every client message type rejects a wrong-typed field with an error
// naming the type and accepts a well-formed one; unknown types are
// rejected; every error names the request it answers (and the window or
// path it was about) so each consumer can claim its own.
//
// Run with: npx tsx --test src/server/__tests__/dispatch.test.ts

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { ClientMessage } from '../../shared/protocol.ts'
import { connect, startTestServer, tmpDir, waitForMessage, waitForType, type Msg } from './helpers.ts'

interface Case {
  /** Required field with the wrong type; absent for types with no fields. */
  bad?: Record<string, unknown>
  good: Record<string, unknown>
  /** Reply that proves `good` was handled; absent means a following ping's pong proves it. */
  reply?: string
}

/** Send `msg` then a ping; resolve with the messages that arrived before the pong. */
async function sendThenPong(ws: WebSocket, msg: object): Promise<Msg[]> {
  const seen: Msg[] = []
  const done = waitForMessage(ws, (m) => {
    if (m.type === 'pong') return true
    seen.push(m)
    return false
  })
  ws.send(JSON.stringify(msg))
  ws.send(JSON.stringify({ type: 'ping' }))
  await done
  return seen
}

// The table is typed over ClientMessage['type'], so a message type added
// without a row here fails to compile.
test('every client message type rejects a wrong-typed field and accepts a well-formed one', async () => {
  const dir = await tmpDir()
  await fs.writeFile(path.join(dir, 'a.txt'), 'a')
  const { url, close, tmux } = await startTestServer()
  tmux.add('shell')
  try {
    const { ws } = await connect(url)
    // Order matters: files:tree sets the cwd that read/write resolve
    // against, and the kill goes last.
    const cases: Record<ClientMessage['type'], Case> = {
      'client:hello': { bad: { build: 42 }, good: { build: null }, reply: 'server:hello' },
      ping: { good: {}, reply: 'pong' },
      'session:list': { good: {}, reply: 'session:list' },
      'session:create': { bad: { name: 42 }, good: { name: 'made' }, reply: 'session:created' },
      'session:rename': { bad: { windowId: 0, name: 42 }, good: { windowId: 0, name: 'renamed' }, reply: 'session:renamed' },
      'terminal:attach': { bad: { windowId: '0' }, good: { windowId: 0, cols: 80, rows: 24 }, reply: 'terminal:history' },
      'terminal:input': { bad: { windowId: 0, data: 42 }, good: { windowId: 0, data: 'x' } },
      'terminal:resize': { bad: { windowId: 0, cols: '80', rows: 24 }, good: { windowId: 0, cols: 81, rows: 24 } },
      'terminal:detach': { bad: { windowId: '0' }, good: { windowId: 0 } },
      'files:tree': { bad: { cwd: 42 }, good: { cwd: dir }, reply: 'files:tree' },
      'files:read': { bad: { path: 42 }, good: { path: 'a.txt' }, reply: 'files:content' },
      'files:write': { bad: { path: 42, content: '' }, good: { path: 'b.txt', content: 'b' }, reply: 'files:saved' },
      'files:watch': { bad: { cwd: 42 }, good: { cwd: dir } },
      'files:unwatch': { good: {} },
      'session:kill': { bad: { windowId: '0' }, good: { windowId: 0 }, reply: 'session:killed' },
    }

    for (const [type, c] of Object.entries(cases)) {
      if (c.bad) {
        // Messages are handled in order, so the pong proves the verdict is in.
        const errors = (await sendThenPong(ws, { type, ...c.bad })).filter((m) => m.type === 'error')
        assert.ok(errors.length > 0, `${type}: a wrong-typed field was accepted`)
        assert.ok(
          errors.some((e) => String(e.message).includes(type)),
          `${type}: the rejection does not name the type: ${JSON.stringify(errors.map((e) => e.message))}`,
        )
        assert.equal(errors[0].request, type, `${type}: the rejection names the request it answers`)
      }
      if (c.reply) {
        const answer = waitForMessage(ws, (m) => m.type === c.reply || m.type === 'error', 5000, `a "${c.reply}" reply`)
        ws.send(JSON.stringify({ type, ...c.good }))
        const got = await answer
        assert.equal(got.type, c.reply, `${type}: well-formed message was rejected: ${got.message}`)
      } else {
        const before = await sendThenPong(ws, { type, ...c.good })
        const rejected = before.find((m) => m.type === 'error')
        assert.equal(rejected, undefined, `${type}: well-formed message was rejected: ${rejected?.message}`)
      }
    }
    ws.close()
  } finally {
    await close()
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('an unknown message type and a message without one are rejected', async () => {
  const { url, close } = await startTestServer()
  try {
    const { ws } = await connect(url)
    for (const payload of [{ type: 'session:explode', windowId: 0 }, { windowId: 0 }, 'just a string', 42]) {
      const [err] = (await sendThenPong(ws, payload as object)).filter((m) => m.type === 'error')
      assert.ok(err, `${JSON.stringify(payload)} was accepted`)
      assert.match(String(err.message), /^Invalid message/)
      assert.equal(err.request, 'unknown')
    }
    ws.close()
  } finally {
    await close()
  }
})

test('an error from files:read names the request and the path', async () => {
  const { url, close } = await startTestServer()
  try {
    const { ws } = await connect(url)
    const error = waitForType(ws, 'error')
    ws.send(JSON.stringify({ type: 'files:read', path: '../etc/passwd' }))
    const err = await error
    assert.equal(err.request, 'files:read')
    assert.equal(err.path, '../etc/passwd')
    ws.close()
  } finally {
    await close()
  }
})

test('an error from terminal:attach names the request and the window', async () => {
  const { url, close, tmux } = await startTestServer({
    ptySpawner: () => {
      throw new Error('no pty for you')
    },
  })
  tmux.add('shell')
  try {
    const { ws } = await connect(url)
    const error = waitForType(ws, 'error')
    ws.send(JSON.stringify({ type: 'terminal:attach', windowId: 0 }))
    const err = await error
    assert.equal(err.request, 'terminal:attach')
    assert.equal(err.windowId, 0)
    // The message of an internal failure is not the client's business.
    assert.equal(err.message, 'Operation failed')
    ws.close()
  } finally {
    await close()
  }
})
