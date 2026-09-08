// Pending for S4 (getTree caps nodes, flags truncation, skips root dot-dirs).
//
// A session whose cwd is a home directory or a big monorepo makes
// files:tree walk everything under it: tens of thousands of nodes shipped
// to a phone that renders a few hundred. The response is capped at 5000
// nodes and says so with `truncated: true`, and dot-directories at the
// root (.cache, .npm, .local) are skipped like node_modules.
//
// Run with: npx tsx --test src/server/__tests__/pending/tree-bounds.test.ts

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { FileNode } from '../../../shared/protocol.ts'
import { connect, startTestServer, tmpDir, waitForType } from '../helpers.ts'

const FILE_COUNT = 6000
const NODE_CAP = 5000

function countNodes(nodes: FileNode[]): number {
  let n = 0
  for (const node of nodes) n += 1 + (node.children ? countNodes(node.children) : 0)
  return n
}

test('files:tree caps the node count, reports truncation and skips root dot-dirs', async () => {
  const dir = await tmpDir()
  const { url, close } = await startTestServer()
  try {
    await fs.mkdir(path.join(dir, 'big'))
    await fs.mkdir(path.join(dir, '.cache'))
    await fs.writeFile(path.join(dir, '.cache', 'junk'), '')
    for (let batch = 0; batch < FILE_COUNT; batch += 500) {
      await Promise.all(
        Array.from({ length: 500 }, (_, i) => fs.writeFile(path.join(dir, 'big', `f${batch + i}`), '')),
      )
    }

    const { ws } = await connect(url)
    const reply = waitForType(ws, 'files:tree', 15_000)
    ws.send(JSON.stringify({ type: 'files:tree', cwd: dir }))
    const msg = await reply
    const entries = msg.entries as FileNode[]

    assert.ok(countNodes(entries) <= NODE_CAP, `tree has ${countNodes(entries)} nodes, cap is ${NODE_CAP}`)
    assert.equal(msg.truncated, true)
    assert.equal(entries.find((n) => n.name === '.cache'), undefined, 'root dot-dirs are skipped')
    ws.close()
  } finally {
    await close()
    await fs.rm(dir, { recursive: true, force: true })
  }
})
