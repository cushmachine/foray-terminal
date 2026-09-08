// File panel <-> WebSocket backend wiring tests.
//
// Run with: npx tsx --test src/__tests__/file-panel.test.ts
//
// Covers:
//  1. Server responds to files:tree with the real directory structure
//  2. Server responds to files:read with real file contents
//  3. Server round-trips files:write -> files:read
//  4. Server rejects path traversal on files:read with an error message
//  5. Server round-trips files:watch -> on-disk change -> files:changed
//  6. MarkdownEditor's Cmd+S / Ctrl+S save keybinding, tested in isolation
//     (no DOM available in this test runner)
//  7. The panel's store reducer: tree, expansion, the save flow, the
//     changed-on-disk conflict, removed files, error routing
//  8. Escape target filtering and the panel width clamp

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { connect, startTestServer, tmpDir, waitForType } from '../server/__tests__/helpers.ts'
import { createSaveKeymap, docReplacement } from '../MarkdownEditor.tsx'
import {
  INITIAL_FILE_STORE,
  insertFile,
  reduceFileStore,
  removeNode,
  type FileStoreAction,
  type FileStoreState,
} from '../files/useFileStore.ts'
import { isEditableTarget } from '../hooks/useEscape.ts'
import {
  FILE_PANEL_DEFAULT_WIDTH,
  FILE_PANEL_MAX_WIDTH,
  FILE_PANEL_MIN_WIDTH,
  clampFilePanelWidth,
} from '../mobile.ts'
import type { FileNode, ServerMessage } from '../shared/protocol.ts'

// ---------------------------------------------------------------------------
// Test 1: files:tree
// ---------------------------------------------------------------------------

test('server handles files:tree and returns the real directory structure', async () => {
  const { url, close } = await startTestServer()
  const dir = await tmpDir('nest-file-panel-')
  try {
    await fs.writeFile(path.join(dir, 'a.txt'), 'a')
    await fs.mkdir(path.join(dir, 'sub'))
    await fs.writeFile(path.join(dir, 'sub', 'b.md'), 'b')

    const { ws } = await connect(url)
    try {
      const responsePromise = waitForType(ws, 'files:tree')
      ws.send(JSON.stringify({ type: 'files:tree', cwd: dir }))
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
    await fs.rm(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// Test 2: files:read (cwd established via files:tree)
// ---------------------------------------------------------------------------

test('server handles files:read using the cwd from a prior files:tree request', async () => {
  const { url, close } = await startTestServer()
  const dir = await tmpDir('nest-file-panel-')
  try {
    await fs.writeFile(path.join(dir, 'notes.md'), '# Hello\n\nWorld')

    const { ws } = await connect(url)
    try {
      const treePromise = waitForType(ws, 'files:tree')
      ws.send(JSON.stringify({ type: 'files:tree', cwd: dir }))
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
    await fs.rm(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// Test 3: files:write then files:read
// ---------------------------------------------------------------------------

test('server handles files:write, then files:read reflects the new content', async () => {
  const { url, close } = await startTestServer()
  const dir = await tmpDir('nest-file-panel-')
  try {
    const { ws } = await connect(url)
    try {
      const treePromise = waitForType(ws, 'files:tree')
      ws.send(JSON.stringify({ type: 'files:tree', cwd: dir }))
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
      const onDisk = await fs.readFile(path.join(dir, 'draft.md'), 'utf-8')
      assert.equal(onDisk, 'draft content')
    } finally {
      ws.close()
    }
  } finally {
    await close()
    await fs.rm(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// Test 4: path traversal rejected
// ---------------------------------------------------------------------------

test('server rejects files:read path traversal with an error message', async () => {
  const { url, close } = await startTestServer()
  const dir = await tmpDir('nest-file-panel-')
  try {
    const { ws } = await connect(url)
    try {
      const treePromise = waitForType(ws, 'files:tree')
      ws.send(JSON.stringify({ type: 'files:tree', cwd: dir }))
      await treePromise

      const errorPromise = waitForType(ws, 'error')
      ws.send(JSON.stringify({ type: 'files:read', path: '../etc/passwd' }))
      const error = await errorPromise

      assert.equal(error.type, 'error')
      assert.ok(typeof error.message === 'string' && error.message.length > 0)
      assert.ok(
        error.message.includes('traversal') || error.message.includes('Invalid path'),
        `error message should indicate path traversal rejection, got: ${error.message}`,
      )
    } finally {
      ws.close()
    }
  } finally {
    await close()
    await fs.rm(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// Test 5: files:watch -> on-disk change -> files:changed
// ---------------------------------------------------------------------------

test('server handles files:watch and pushes files:changed on external file changes', async () => {
  const { url, close } = await startTestServer()
  const dir = await tmpDir('nest-file-panel-')
  try {
    const file = path.join(dir, 'live.txt')
    await fs.writeFile(file, 'initial')

    const { ws } = await connect(url)
    try {
      // A write before the watcher's initial scan is done can go unseen;
      // files:watching says the scan is done.
      const watching = waitForType(ws, 'files:watching')
      ws.send(JSON.stringify({ type: 'files:watch', cwd: dir }))
      assert.equal((await watching).cwd, dir)
      const changedPromise = waitForType(ws, 'files:changed')
      await fs.writeFile(file, 'updated externally')
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
    await fs.rm(dir, { recursive: true, force: true })
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

// ---------------------------------------------------------------------------
// Test 7: the store reducer (pure)
// ---------------------------------------------------------------------------

const TREE: FileNode[] = [
  { name: 'docs', path: 'docs', type: 'dir', children: [
    { name: 'a.md', path: 'docs/a.md', type: 'file' },
  ] },
  { name: 'README.md', path: 'README.md', type: 'file' },
]

function run(actions: FileStoreAction[], from: FileStoreState = INITIAL_FILE_STORE): FileStoreState {
  return actions.reduce(reduceFileStore, from)
}

function msg(m: ServerMessage): FileStoreAction {
  return { type: 'message', msg: m }
}

/** README.md open, fetched, and being edited. */
function editingReadme(): FileStoreState {
  return run([
    msg({ type: 'files:tree', entries: TREE }),
    { type: 'select', path: 'README.md' },
    msg({ type: 'files:content', path: 'README.md', content: '# hi' }),
    { type: 'edit' },
    { type: 'change', content: '# hi there' },
  ])
}

test('store: files:tree sets the tree and the truncated flag', () => {
  const partial = run([msg({ type: 'files:tree', entries: TREE, truncated: true })])
  assert.deepEqual(partial.tree, TREE)
  assert.equal(partial.truncated, true)
  assert.equal(partial.treeError, null)
  const full = run([msg({ type: 'files:tree', entries: TREE })], partial)
  assert.equal(full.truncated, false)
})

test('store: toggle-dir expands and collapses; expansion survives a reset', () => {
  const opened = run([{ type: 'toggle-dir', path: 'docs' }])
  assert.ok(opened.expanded.has('docs'))
  const afterReset = run([{ type: 'reset' }], opened)
  assert.ok(afterReset.expanded.has('docs'))
  assert.equal(afterReset.tree, null)
  const closed = run([{ type: 'toggle-dir', path: 'docs' }], afterReset)
  assert.ok(!closed.expanded.has('docs'))
})

test('store: a file\'s content stays cached across deselect and reselect', () => {
  const cached = run([
    { type: 'select', path: 'README.md' },
    msg({ type: 'files:content', path: 'README.md', content: '# hi' }),
    { type: 'select', path: null },
    { type: 'select', path: 'README.md' },
  ])
  assert.equal(cached.contents['README.md'], '# hi')
})

test('store: selecting another file ends the edit in progress', () => {
  const state = run([{ type: 'select', path: 'docs/a.md' }], editingReadme())
  assert.equal(state.editing, false)
  assert.equal(state.editContent, '')
  assert.equal(state.openFile, 'docs/a.md')
})

test('store: save flow caches optimistically, then files:saved ends the edit', () => {
  const saving = run([{ type: 'save' }], editingReadme())
  assert.equal(saving.saving, true)
  assert.equal(saving.editing, true)
  assert.equal(saving.contents['README.md'], '# hi there')
  const saved = run([msg({ type: 'files:saved', path: 'README.md' })], saving)
  assert.equal(saved.saving, false)
  assert.equal(saved.editing, false)
  assert.equal(saved.contents['README.md'], '# hi there')
})

test('store: save without an edit in progress is a no-op', () => {
  const state = run([{ type: 'select', path: 'README.md' }])
  assert.equal(run([{ type: 'save' }], state), state)
})

test('store: the edit survives a reconnect reset; the cache does not', () => {
  const state = run([{ type: 'reset' }], editingReadme())
  assert.equal(state.editing, true)
  assert.equal(state.editContent, '# hi there')
  assert.deepEqual(state.contents, {})
})

test('store: files:changed while editing raises the conflict notice; reload takes the disk copy', () => {
  const changed = run([msg({ type: 'files:changed', path: 'README.md', content: '# from disk' })], editingReadme())
  assert.deepEqual(changed.diskChange, { path: 'README.md', content: '# from disk' })
  assert.equal(changed.editContent, '# hi there', 'the edit is not overwritten silently')
  assert.equal(changed.contents['README.md'], '# from disk', 'the preview cache is fresh')

  const reloaded = run([{ type: 'reload-from-disk' }], changed)
  assert.equal(reloaded.diskChange, null)
  assert.equal(reloaded.editContent, '# from disk')
})

test('store: keep-edits clears the notice and keeps the edit', () => {
  const changed = run([msg({ type: 'files:changed', path: 'README.md', content: '# from disk' })], editingReadme())
  const kept = run([{ type: 'keep-edits' }], changed)
  assert.equal(kept.diskChange, null)
  assert.equal(kept.editContent, '# hi there')
})

test('store: our own save echoing back through the watcher is not a conflict', () => {
  const state = run([
    { type: 'save' },
    msg({ type: 'files:changed', path: 'README.md', content: '# hi there' }),
  ], editingReadme())
  assert.equal(state.diskChange, null)
})

test('store: files:changed for another file only refreshes the cache', () => {
  const state = run([msg({ type: 'files:changed', path: 'docs/a.md', content: 'x' })], editingReadme())
  assert.equal(state.diskChange, null)
  assert.equal(state.contents['docs/a.md'], 'x')
})

test('store: files:changed for a new path adds it to the tree in sorted position', () => {
  const state = run([
    msg({ type: 'files:tree', entries: TREE }),
    msg({ type: 'files:changed', path: 'docs/sub/new.md', content: '' }),
    msg({ type: 'files:changed', path: 'Makefile', content: '' }),
  ])
  assert.deepEqual(state.tree!.map((n) => n.name), ['docs', 'Makefile', 'README.md'])
  const docs = state.tree![0]
  assert.deepEqual(docs.children!.map((n) => `${n.type}:${n.name}`), ['dir:sub', 'file:a.md'])
  assert.equal(docs.children![0].children![0].path, 'docs/sub/new.md')
  // Already present: untouched.
  assert.equal(insertFile(state.tree!, 'README.md'), state.tree)
})

test('store: files:removed drops the node, forgets its content, and flags the open file', () => {
  const state = run([
    msg({ type: 'files:content', path: 'docs/a.md', content: 'a' }),
    msg({ type: 'files:removed', path: 'docs/a.md' }),
  ], editingReadme())
  assert.equal(state.removed, false)
  assert.equal(state.contents['docs/a.md'], undefined)
  assert.deepEqual(removeNode(TREE, 'docs/a.md')[0].children, [])
  assert.deepEqual(state.tree![0].children, [])

  const gone = run([msg({ type: 'files:removed', path: 'README.md' })], state)
  assert.equal(gone.removed, true)
  assert.equal(gone.editing, true, 'the edit stays so a save can recreate the file')
  assert.deepEqual(gone.tree!.map((n) => n.name), ['docs'])
  const recreated = run([msg({ type: 'files:saved', path: 'README.md' })], gone)
  assert.equal(recreated.removed, false)
})

test('store: removeNode takes a whole directory', () => {
  assert.deepEqual(removeNode(TREE, 'docs').map((n) => n.name), ['README.md'])
})

test('store: errors route by request; a write failure keeps the edit', () => {
  const readFail = run([
    { type: 'select', path: 'README.md' },
    msg({ type: 'error', message: 'nope', request: 'files:read', path: 'README.md' }),
  ])
  assert.equal(readFail.fileError, 'nope')
  assert.equal(readFail.treeError, null)

  const treeFail = run([msg({ type: 'error', message: 'bad cwd', request: 'files:tree' })])
  assert.equal(treeFail.treeError, 'bad cwd')
  assert.equal(treeFail.fileError, null)

  const writeFail = run([
    { type: 'save' },
    msg({ type: 'error', message: 'EACCES', request: 'files:write', path: 'README.md' }),
  ], editingReadme())
  assert.equal(writeFail.saving, false)
  assert.equal(writeFail.editing, true)
  assert.equal(writeFail.editContent, '# hi there')
  assert.equal(writeFail.saveError, 'EACCES')
  assert.equal(writeFail.fileError, null)
})

test('store: errors from other requests are ignored', () => {
  const before = editingReadme()
  const after = run([msg({ type: 'error', message: 'x', request: 'session:create' })], before)
  assert.equal(after, before)
})

test('store: edit and cancel', () => {
  const state = editingReadme()
  assert.equal(state.editing, true)
  const cancelled = run([{ type: 'cancel-edit' }], state)
  assert.equal(cancelled.editing, false)
  assert.equal(cancelled.editContent, '')
  assert.equal(cancelled.contents['README.md'], '# hi', 'cancel does not touch the cache')
})

// ---------------------------------------------------------------------------
// Test 8: editor sync, Escape targets, panel width
// ---------------------------------------------------------------------------

test('docReplacement: equal content is a no-op, otherwise the whole doc is replaced', () => {
  assert.equal(docReplacement('abc', 'abc'), null)
  assert.deepEqual(docReplacement('abc', 'abcd'), { from: 0, to: 3, insert: 'abcd' })
  assert.deepEqual(docReplacement('', 'x'), { from: 0, to: 0, insert: 'x' })
})

test('isEditableTarget: inputs, textareas and contenteditable keep Escape; buttons do not', () => {
  assert.equal(isEditableTarget({ tagName: 'TEXTAREA' }), true)
  assert.equal(isEditableTarget({ tagName: 'input' }), true)
  assert.equal(isEditableTarget({ tagName: 'DIV', isContentEditable: true }), true)
  assert.equal(isEditableTarget({ tagName: 'BUTTON', isContentEditable: false }), false)
  assert.equal(isEditableTarget(null), false)
})

test('clampFilePanelWidth: bounded, rounded, and a sane default for garbage', () => {
  assert.equal(clampFilePanelWidth(FILE_PANEL_MIN_WIDTH - 50), FILE_PANEL_MIN_WIDTH)
  assert.equal(clampFilePanelWidth(FILE_PANEL_MAX_WIDTH + 50), FILE_PANEL_MAX_WIDTH)
  assert.equal(clampFilePanelWidth(320.4), 320)
  assert.equal(clampFilePanelWidth(NaN), FILE_PANEL_DEFAULT_WIDTH)
})
