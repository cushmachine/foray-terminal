// Pending for S4 (error and close listeners attached before the awaited welcome).
//
// The connection handler awaits tmux for the welcome session list before
// handleConnection installs the socket's error listener. A socket that
// errors during that wait (a bad frame from a half-dead phone, say) emits
// 'error' on an EventEmitter with no listener, which throws, which takes
// the whole server down.
//
// Run with: npx tsx --test src/server/__tests__/pending/error-listener-first.test.ts

import { test } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import net from 'node:net'
import type { TmuxExecutor } from '../../tmux.ts'
import { fakeTmux, startTestServer, until } from '../helpers.ts'

/** Complete a WebSocket upgrade by hand so we can write raw frames afterwards. */
function rawUpgrade(url: string): Promise<net.Socket> {
  const { hostname, port } = new URL(url)
  return new Promise((resolve, reject) => {
    const socket = net.connect(Number(port), hostname, () => {
      const key = crypto.randomBytes(16).toString('base64')
      socket.write(
        `GET /ws HTTP/1.1\r\nHost: ${hostname}:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
        `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
      )
    })
    socket.once('data', (data) => {
      const status = String(data).split('\r\n')[0]
      if (status.startsWith('HTTP/1.1 101')) resolve(socket)
      else reject(new Error(`upgrade refused: ${status}`))
    })
    socket.once('error', reject)
  })
}

/** A masked frame with RSV1 set: no extension was negotiated, so ws rejects it. */
const BAD_FRAME = Buffer.from([0xf1, 0x80, 0, 0, 0, 0])

test('a socket error before the welcome completes does not crash the process', async () => {
  const tmux = fakeTmux()
  // Hold the welcome's session list so the error lands during the await.
  let listing = false
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const exec: TmuxExecutor = async (cmd, args) => {
    if (args[0] === 'list-sessions') {
      listing = true
      await gate
    }
    return tmux.exec(cmd, args)
  }
  const { url, close } = await startTestServer({ tmuxExec: exec })
  const uncaught: unknown[] = []
  const onUncaught = (err: unknown): void => {
    uncaught.push(err)
  }
  process.on('uncaughtException', onUncaught)
  try {
    const socket = await rawUpgrade(url)
    await until(() => listing, 'the welcome to reach tmux')
    socket.write(BAD_FRAME)
    // Let the frame arrive and be parsed before the welcome resumes.
    await new Promise((resolve) => setTimeout(resolve, 50))
    release()
    await new Promise((resolve) => setTimeout(resolve, 50))
    socket.destroy()

    assert.deepEqual(uncaught, [], 'the socket error escaped as an uncaught exception')
  } finally {
    process.off('uncaughtException', onUncaught)
    release()
    await close()
  }
})
