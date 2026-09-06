// File panel <-> WebSocket backend wiring tests.
//
// Run with: npm run test:file-panel
// (executed directly via `tsx`, using node's built-in test runner)
//
// Covers:
//  1. Server responds to files:tree with the real directory structure
//  2. Server responds to files:read with real file contents
//  3. Server round-trips files:write -> files:read
//  4. Server rejects path traversal on files:read with an error message
//  5. Server round-trips files:watch -> on-disk change -> files:changed
//  6. MarkdownEditor's Cmd+S / Ctrl+S save keybinding, tested in isolation
//     (no DOM available in this test runner)

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { startServer } from '../server/index.ts'
import { createSaveKeymap } from '../MarkdownEditor.tsx'

async function makeTmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'nest-file-panel-'))
}

/** Connect a WebSocket to the given server and resolve once the welcome message arrives. */
async function connectAndWaitForWelcome(url: string): Promise<WebSocket> {
  const wsUrl = url.replace(/^http/, 'ws') + '/ws'
  const ws = new WebSocket(wsUrl)
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('timed out waiting for welcome')), 5000)
    ws.addEventListener(
      'message',
      () => {
        clearTimeout(timeout)
        resolve()
      },
      { once: true },
    )
    ws.addEventListener('error', reject)
  })
  return ws
}

/** Send a message and wait for the next message whose `type` matches. */
function waitForType(ws: WebSocket, type: string, timeoutMs = 5000): Promise<any> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error(`timed out waiting for message of type "${type}"`)),
      timeoutMs,
    )
    const handler = (event: MessageEvent) => {
      const msg = JSON.parse(event.data.toString())
      if (msg.type === type) {
        clearTimeout(timeout)
        ws.removeEventListener('message', handler)
        resolve(msg)
      }
    }
    ws.addEventListener('message', handler)
  })
}

// ---------------------------------------------------------------------------
// Test 1: files:tree
// ---------------------------------------------------------------------------

test('server handles files:tree and returns the real directory structure', async () => {
  const { url, close } = await startServer(0)
  const tmpDir = await makeTmpDir()
  try {
    await fs.writeFile(path.join(tmpDir, 'a.txt'), 'a')
    await fs.mkdir(path.join(tmpDir, 'sub'))
    await fs.writeFile(path.join(tmpDir, 'sub', 'b.md'), 'b')

    const ws = await connectAndWaitForWelcome(url)
    try {
      const responsePromise = waitForType(ws, 'files:tree')
      ws.send(JSON.stringify({ type: 'files:tree', cwd: tmpDir }))
      const response = await responsePromise

      assert.equal(response.type, 'files:tree')
      assert.ok(Array.isArray(response.entries))
      const names = response.entries.map((e: any) => e.name).sort()
      assert.deepEqual(names, ['a.txt', 'sub'])

      const sub = response.entries.find((e: any) => e.name === 'sub')
      assert.equal(sub.type, 'dir')
      assert.equal(sub.children[0].name, 'b.md')
      assert.equal(sub.children[0].type, 'file')
    } finally {
      ws.close()
    }
  } finally {
    await close()
    await fs.rm(tmpDir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// Test 2: files:read (cwd established via files:tree)
// ---------------------------------------------------------------------------

test('server handles files:read using the cwd from a prior files:tree request', async () => {
  const { url, close } = await startServer(0)
  const tmpDir = await makeTmpDir()
  try {
    await fs.writeFile(path.join(tmpDir, 'notes.md'), '# Hello\n\nWorld')

    const ws = await connectAndWaitForWelcome(url)
    try {
      const treePromise = waitForType(ws, 'files:tree')
      ws.send(JSON.stringify({ type: 'files:tree', cwd: tmpDir }))
      await treePromise

      const contentPromise = waitForType(ws, 'files:content')
      ws.send(JSON.stringify({ type: 'files:read', path: 'notes.md' }))
      const response = await contentPromise

      assert.equal(response.type, 'files:content')
      assert.equal(response.path, 'notes.md')
      assert.equal(response.content, '# Hello\n\nWorld')
    } finally {
      ws.close()
    }
  } finally {
    await close()
    await fs.rm(tmpDir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// Test 3: files:write then files:read
// ---------------------------------------------------------------------------

test('server handles files:write, then files:read reflects the new content', async () => {
  const { url, close } = await startServer(0)
  const tmpDir = await makeTmpDir()
  try {
    const ws = await connectAndWaitForWelcome(url)
    try {
      const treePromise = waitForType(ws, 'files:tree')
      ws.send(JSON.stringify({ type: 'files:tree', cwd: tmpDir }))
      await treePromise

      const savedPromise = waitForType(ws, 'files:saved')
      ws.send(JSON.stringify({ type: 'files:write', path: 'draft.md', content: 'draft content' }))
      const saved = await savedPromise
      assert.equal(saved.type, 'files:saved')
      assert.equal(saved.path, 'draft.md')

      const contentPromise = waitForType(ws, 'files:content')
      ws.send(JSON.stringify({ type: 'files:read', path: 'draft.md' }))
      const content = await contentPromise
      assert.equal(content.content, 'draft content')

      // Also verify it actually landed on disk.
      const onDisk = await fs.readFile(path.join(tmpDir, 'draft.md'), 'utf-8')
      assert.equal(onDisk, 'draft content')
    } finally {
      ws.close()
    }
  } finally {
    await close()
    await fs.rm(tmpDir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// Test 4: path traversal rejected
// ---------------------------------------------------------------------------

test('server rejects files:read path traversal with an error message', async () => {
  const { url, close } = await startServer(0)
  const tmpDir = await makeTmpDir()
  try {
    const ws = await connectAndWaitForWelcome(url)
    try {
      const treePromise = waitForType(ws, 'files:tree')
      ws.send(JSON.stringify({ type: 'files:tree', cwd: tmpDir }))
      await treePromise

      const errorPromise = waitForType(ws, 'error')
      ws.send(JSON.stringify({ type: 'files:read', path: '../etc/passwd' }))
      const error = await errorPromise

      assert.equal(error.type, 'error')
      assert.ok(typeof error.message === 'string' && error.message.length > 0)
    } finally {
      ws.close()
    }
  } finally {
    await close()
    await fs.rm(tmpDir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// Test 5: files:watch -> on-disk change -> files:changed
// ---------------------------------------------------------------------------

test('server handles files:watch and pushes files:changed on external file changes', async () => {
  const { url, close } = await startServer(0)
  const tmpDir = await makeTmpDir()
  try {
    await fs.writeFile(path.join(tmpDir, 'live.txt'), 'initial')

    const ws = await connectAndWaitForWelcome(url)
    try {
      ws.send(JSON.stringify({ type: 'files:watch', cwd: tmpDir }))
      // Give chokidar a moment to complete its initial scan (matches the
      // pattern used in files.test.ts's watchDir test) before mutating the file.
      await new Promise((resolve) => setTimeout(resolve, 500))

      const changedPromise = waitForType(ws, 'files:changed')
      await fs.writeFile(path.join(tmpDir, 'live.txt'), 'updated externally')
      const changed = await changedPromise

      assert.equal(changed.type, 'files:changed')
      assert.equal(changed.path, 'live.txt')
      assert.equal(changed.content, 'updated externally')

      // files:unwatch should not error and should stop future notifications.
      ws.send(JSON.stringify({ type: 'files:unwatch' }))
    } finally {
      ws.close()
    }
  } finally {
    await close()
    await fs.rm(tmpDir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// Test 6: MarkdownEditor save keymap (isolated from the DOM)
// ---------------------------------------------------------------------------

test('createSaveKeymap: Mod-s binding invokes onSave and reports handled', () => {
  let called = 0
  const bindings = createSaveKeymap(() => {
    called += 1
  })

  assert.equal(bindings.length, 1)
  assert.equal(bindings[0].key, 'Mod-s')

  // The `run` function is called with an EditorView in real usage, but our
  // binding never touches it, so a dummy value is enough to exercise it here.
  const handled = bindings[0].run!(undefined as any)

  assert.equal(called, 1)
  assert.equal(handled, true)
})

test('createSaveKeymap: with no onSave, run() is a safe no-op that still reports handled', () => {
  const bindings = createSaveKeymap(undefined)
  const handled = bindings[0].run!(undefined as any)
  assert.equal(handled, true)
})
