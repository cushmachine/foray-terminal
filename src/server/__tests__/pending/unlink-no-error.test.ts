// Pending for S4 (watcher unlink sends files:removed).
//
// The directory watcher reports every event by re-reading the file and
// sending files:changed. A deleted file cannot be read, so today a delete
// is an ENOENT in the server log and silence for the client, which keeps
// showing a file that no longer exists. A delete is reported as
// files:removed instead.
//
// Run with: npx tsx --test src/server/__tests__/pending/unlink-no-error.test.ts

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { handleTestConnection, tmpDir, until } from '../helpers.ts'

test('deleting a watched file produces files:removed, not a logged error', { timeout: 15_000 }, async () => {
  const dir = await tmpDir()
  const conn = handleTestConnection()
  try {
    await fs.writeFile(path.join(dir, 'a.txt'), 'a')
    conn.socket.receive({ type: 'files:watch', cwd: dir })

    // The watcher reports nothing until its initial scan is done, and the
    // handler does not expose that moment; keep touching a probe file until
    // a change comes through. The 300 ms per-file debounce sets the pace.
    const probe = path.join(dir, 'probe.txt')
    const deadline = Date.now() + 10_000
    while (!conn.sent.some((m) => m.type === 'files:changed' && m.path === 'probe.txt')) {
      if (Date.now() > deadline) throw new Error('watcher never reported the probe file')
      await fs.writeFile(probe, String(Date.now()))
      await new Promise((resolve) => setTimeout(resolve, 400))
    }

    await fs.unlink(path.join(dir, 'a.txt'))
    const removed = (): boolean => conn.sent.some((m) => m.type === 'files:removed')
    await until(() => removed() || conn.errors.length > 0, 'the watcher to react to the delete', 3000)

    assert.deepEqual(conn.errors, [], 'the delete was logged as an error instead of reported')
    const msg = conn.sent.find((m) => m.type === 'files:removed')
    assert.deepEqual(msg, { type: 'files:removed', path: 'a.txt' })
  } finally {
    conn.socket.emit('close')
    await fs.rm(dir, { recursive: true, force: true })
  }
})
