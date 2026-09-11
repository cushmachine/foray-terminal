// Scrollback E2E: the client's copy of the history against tmux's own,
// on this machine's real tmux server.
//
// Run with: npm run test:history   (requires tmux; not part of `npm test`)
//
// The unit suites drive the same code with a fake tmux, but the holes this
// guards against only show up against the real thing: the pane keeps
// printing while tmux answers, and what a capture holds is decided by
// tmux's own rows, joins and screen boundary rather than by a fixture.
//
// The session it creates is named foray_e2e-history and killed afterwards.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { startServer } from '../server/index.ts'
import { TEST_TOKEN, connect, waitForTypeOrError } from '../server/__tests__/helpers.ts'
import { tmuxAsync, tmuxSync } from './helpers.ts'

const SESSION = 'e2e-history'

function hasTmux(): boolean {
  try {
    tmuxSync(['-V'])
    return true
  } catch {
    return false
  }
}

const tmuxIt = hasTmux() ? test : test.skip
if (!hasTmux()) console.log('[e2e] tmux not found; every test will be skipped')

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** Colour escapes out: the client renders them, the comparison does not care. */
const plain = (line: string): string =>
  // eslint-disable-next-line no-control-regex
  line.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')

/**
 * Print lines that repeat, slowly enough that every batch is its own
 * check. A capture then holds the run the client ends on more than once,
 * which is where the server used to append from the wrong copy and drop
 * the lines in between.
 */
tmuxIt('e2e: repeating output reaches the browser with no lines missing', async () => {
  const { url, close } = await startServer(0, { quiet: true, auth: { token: TEST_TOKEN } })
  let windowId: number | null = null
  try {
    const { ws } = await connect(url)
    try {
      const createdPromise = waitForTypeOrError(ws, 'session:created')
      ws.send(JSON.stringify({ type: 'session:create', name: SESSION }))
      windowId = (await createdPromise).window.id as number

      // The browser's scrollback: a reset replaces it, anything else appends.
      const client: string[] = []
      ws.addEventListener('message', (event: { data: unknown }) => {
        const msg = JSON.parse(String(event.data))
        if (msg.type !== 'terminal:history' || msg.windowId !== windowId) return
        if (msg.reset) client.length = 0
        client.push(...(msg.lines as string[]).map(plain))
      })

      ws.send(JSON.stringify({ type: 'terminal:attach', windowId, cols: 80, rows: 24 }))
      await sleep(1500)
      ws.send(JSON.stringify({
        type: 'terminal:input',
        windowId,
        data: 'for i in $(seq 1 60); do echo AAA; echo BBB; sleep 0.15; done\r',
      }))
      await sleep(60 * 150 + 3000)
      // Scroll the last screenful into history so the two are comparable.
      ws.send(JSON.stringify({ type: 'terminal:input', windowId, data: 'printf "\\n%.0s" $(seq 1 40)\r' }))
      await sleep(3000)

      const captured = await tmuxAsync(['capture-pane', '-p', '-J', '-t', `$${windowId}`, '-S', '-', '-E', '-1'])
      const history = captured.stdout.split('\n').map(plain)
      history.pop() // trailing newline

      assert.ok(client.length > 0, 'the client was sent some history')
      // The client holds tmux's history from its first line on, in order.
      const from = history.indexOf(client[0])
      assert.ok(from >= 0, `the client's first line is not in tmux's history: ${JSON.stringify(client[0])}`)
      const expected = history.slice(from, from + client.length)
      const at = client.findIndex((line, i) => line !== expected[i])
      assert.equal(
        at,
        -1,
        at < 0 ? '' : `line ${at} diverges: tmux ${JSON.stringify(expected.slice(at, at + 3))}` +
          ` vs client ${JSON.stringify(client.slice(at, at + 3))}`,
      )
      assert.equal(client.length, history.length - from, 'the client is missing lines off the end')
    } finally {
      try { ws.close() } catch {}
    }
  } finally {
    if (windowId !== null) {
      try { tmuxSync(['kill-session', '-t', `$${windowId}`]) } catch {}
    }
    await close()
  }
})
