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

/**
 * Resizing is the one mechanism present only where the bug shows up: the
 * desktop resizes the pty with the window, phones keep a fixed size. Every
 * width change makes tmux reflow its wrapped history, so the row count
 * moves without a single new line being written, and every height change
 * moves rows between the screen and the history. Both feed the matcher a
 * capture that looks nothing like the last one while output keeps landing.
 *
 * The lines are numbered and wider than the narrowest pane, so a duplicate,
 * a dropped line and a line spliced mid-word are all visible in the numbers.
 */
tmuxIt('e2e: resizing while output lands does not duplicate or lose lines', async () => {
  const { url, close } = await startServer(0, { quiet: true, auth: { token: TEST_TOKEN } })
  let windowId: number | null = null
  try {
    const { ws } = await connect(url)
    try {
      const createdPromise = waitForTypeOrError(ws, 'session:created')
      ws.send(JSON.stringify({ type: 'session:create', name: `${SESSION}-resize` }))
      windowId = (await createdPromise).window.id as number

      const client: string[] = []
      ws.addEventListener('message', (event: { data: unknown }) => {
        const msg = JSON.parse(String(event.data))
        if (msg.type !== 'terminal:history' || msg.windowId !== windowId) return
        if (msg.reset) client.length = 0
        client.push(...(msg.lines as string[]).map(plain))
      })

      ws.send(JSON.stringify({ type: 'terminal:attach', windowId, cols: 120, rows: 30 }))
      await sleep(1500)
      // 140 characters, so it wraps at every width below that and at none above.
      ws.send(JSON.stringify({
        type: 'terminal:input',
        windowId,
        data: 'for i in $(seq 1 120); do printf "L%04d %s\\n" "$i" "$(printf "x%.0s" $(seq 1 130))"; sleep 0.12; done\r',
      }))

      // Drag the window about while the lines land: wider, narrower, shorter, taller.
      const sizes = [
        { cols: 200, rows: 30 }, { cols: 70, rows: 30 }, { cols: 200, rows: 18 },
        { cols: 90, rows: 44 }, { cols: 140, rows: 30 },
      ]
      for (const size of sizes) {
        await sleep(1800)
        ws.send(JSON.stringify({ type: 'terminal:resize', windowId, ...size }))
      }

      await sleep(120 * 120 + 3000)
      ws.send(JSON.stringify({ type: 'terminal:input', windowId, data: 'printf "\\n%.0s" $(seq 1 50)\r' }))
      await sleep(3000)

      const numbers = (lines: readonly string[]): number[] =>
        lines.flatMap((line) => {
          const m = /^L(\d{4}) x+$/.exec(line.trimEnd())
          return m ? [Number(m[1])] : []
        })
      const seen = numbers(client)
      assert.ok(seen.length > 20, `the client saw ${seen.length} whole numbered lines, expected most of 120`)
      const dupe = seen.findIndex((n, i) => i > 0 && n <= seen[i - 1])
      assert.equal(dupe, -1, dupe < 0 ? '' :
        `line ${dupe} goes backwards: ${JSON.stringify(seen.slice(Math.max(0, dupe - 2), dupe + 3))}`)
      const missing = []
      for (let n = seen[0]; n <= seen[seen.length - 1]; n++) if (!seen.includes(n)) missing.push(n)
      assert.deepEqual(missing, [], `lines the client never got: ${missing.join(',')}`)
      // Nothing spliced mid-word: every L-line is whole or absent, never a fragment.
      const garbled = client.filter((line) => /L\d{4}/.test(line) && !/^L\d{4} x*$/.test(line.trimEnd()))
      assert.deepEqual(garbled, [], `lines arrived spliced: ${JSON.stringify(garbled.slice(0, 3))}`)
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
