// Filesystem API (getTree, readFile, writeFile, watchDir) tests.
//
// Run with: npx tsx --test src/server/__tests__/files.test.ts
// (executed directly via `tsx`, using node's built-in test runner)
//
// These tests use real filesystem operations on temp directories — no
// mocking needed. Each test creates its own temp dir and cleans it up in a
// finally block.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import chokidar, { type ChokidarOptions, type FSWatcher } from 'chokidar'
import { getTree, readFile, writeFile, watchDir, type Watcher } from '../files.ts'
import type { Logger } from '../log.ts'
import type { FileNode } from '../../shared/protocol.ts'
import { connect, handleTestConnection, startTestServer, tmpDir, until, waitForType } from './helpers.ts'

/** Flatten a tree into a list of names, for easy "does X appear anywhere" checks. */
function collectNames(nodes: FileNode[]): string[] {
  const names: string[] = []
  for (const node of nodes) {
    names.push(node.name)
    if (node.children) names.push(...collectNames(node.children))
  }
  return names
}

function findNode(nodes: FileNode[], name: string): FileNode | undefined {
  for (const node of nodes) {
    if (node.name === name) return node
    if (node.children) {
      const found = findNode(node.children, name)
      if (found) return found
    }
  }
  return undefined
}

test('getTree: basic structure, dirs before files, correct types', async () => {
  const dir = await tmpDir()
  try {
    await fs.writeFile(path.join(dir, 'a.txt'), 'a')
    await fs.writeFile(path.join(dir, 'b.md'), 'b')
    await fs.mkdir(path.join(dir, 'sub', 'deep'), { recursive: true })
    await fs.writeFile(path.join(dir, 'sub', 'c.ts'), 'c')
    await fs.writeFile(path.join(dir, 'sub', 'deep', 'd.json'), 'd')

    const { entries: tree } = await getTree(dir)

    // Top level: sub (dir) should come before a.txt, b.md (files).
    assert.equal(tree.length, 3)
    assert.equal(tree[0].name, 'sub')
    assert.equal(tree[0].type, 'dir')
    assert.equal(tree[1].name, 'a.txt')
    assert.equal(tree[1].type, 'file')
    assert.equal(tree[2].name, 'b.md')
    assert.equal(tree[2].type, 'file')

    const sub = tree[0]
    assert.ok(sub.children)
    // sub/deep (dir) before sub/c.ts (file)
    assert.equal(sub.children![0].name, 'deep')
    assert.equal(sub.children![0].type, 'dir')
    assert.equal(sub.children![1].name, 'c.ts')
    assert.equal(sub.children![1].type, 'file')

    const deep = sub.children![0]
    assert.ok(deep.children)
    assert.equal(deep.children![0].name, 'd.json')
    assert.equal(deep.children![0].type, 'file')
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('getTree: respects .gitignore', async () => {
  const dir = await tmpDir()
  try {
    await fs.writeFile(path.join(dir, 'keep.txt'), 'keep')
    await fs.writeFile(path.join(dir, 'ignored.log'), 'ignored')
    await fs.writeFile(path.join(dir, '.gitignore'), '*.log\n')

    const { entries } = await getTree(dir)
    const names = collectNames(entries)

    assert.ok(!names.includes('ignored.log'), 'ignored.log should be filtered out')
    assert.ok(names.includes('keep.txt'), 'keep.txt should remain')
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('getTree: always skips node_modules, .git, dist, .DS_Store and tool caches, anywhere', async () => {
  const dir = await tmpDir()
  try {
    await fs.mkdir(path.join(dir, 'src'), { recursive: true })
    await fs.writeFile(path.join(dir, 'src', 'a.ts'), 'a')
    await fs.mkdir(path.join(dir, 'node_modules', 'pkg'), { recursive: true })
    await fs.writeFile(path.join(dir, 'node_modules', 'pkg', 'index.js'), '')
    await fs.mkdir(path.join(dir, '.git'), { recursive: true })
    await fs.writeFile(path.join(dir, '.git', 'HEAD'), '')
    await fs.mkdir(path.join(dir, 'dist'), { recursive: true })
    await fs.writeFile(path.join(dir, 'dist', 'bundle.js'), '')
    await fs.writeFile(path.join(dir, '.DS_Store'), '')
    await fs.mkdir(path.join(dir, 'src', '__pycache__'), { recursive: true })
    await fs.writeFile(path.join(dir, 'src', '__pycache__', 'a.pyc'), '')
    await fs.mkdir(path.join(dir, '.venv', 'lib'), { recursive: true })
    await fs.writeFile(path.join(dir, '.venv', 'lib', 'x.py'), '')

    const { entries } = await getTree(dir)
    const names = collectNames(entries)

    for (const skipped of ['node_modules', '.git', 'dist', '.DS_Store', '__pycache__', 'a.pyc', '.venv', 'x.py']) {
      assert.ok(!names.includes(skipped), `${skipped} is listed`)
    }
    assert.ok(names.includes('src'))
    assert.ok(names.includes('a.ts'))
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('getTree: respects maxDepth', async () => {
  const dir = await tmpDir()
  try {
    await fs.mkdir(path.join(dir, 'a', 'b', 'c', 'd', 'e', 'f'), { recursive: true })
    await fs.writeFile(path.join(dir, 'a', 'b', 'c', 'd', 'e', 'f', 'deep.txt'), 'deep')

    const { entries } = await getTree(dir, 3)
    const names = collectNames(entries)

    // a (depth1) -> b (depth2) -> c (depth3) should be visible, but c's
    // contents (d, e, f, deep.txt) should not be traversed.
    assert.ok(names.includes('a'))
    assert.ok(names.includes('b'))
    assert.ok(names.includes('c'))
    assert.ok(!names.includes('d'))
    assert.ok(!names.includes('e'))
    assert.ok(!names.includes('f'))
    assert.ok(!names.includes('deep.txt'))
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('readFile: reads file contents', async () => {
  const dir = await tmpDir()
  try {
    await fs.writeFile(path.join(dir, 'hello.txt'), 'hello world')
    const content = await readFile(dir, 'hello.txt')
    assert.equal(content, 'hello world')
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('readFile: rejects path traversal', async () => {
  const dir = await tmpDir()
  try {
    await assert.rejects(() => readFile(dir, '../etc/passwd'))
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('readFile: rejects absolute paths', async () => {
  const dir = await tmpDir()
  try {
    await assert.rejects(() => readFile(dir, '/etc/passwd'))
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('writeFile: writes and reads back', async () => {
  const dir = await tmpDir()
  try {
    await writeFile(dir, 'output.txt', 'written content')
    const onDisk = await fs.readFile(path.join(dir, 'output.txt'), 'utf-8')
    assert.equal(onDisk, 'written content')
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('writeFile: creates parent directories', async () => {
  const dir = await tmpDir()
  try {
    await writeFile(dir, 'new/nested/file.txt', 'nested content')
    const onDisk = await fs.readFile(path.join(dir, 'new', 'nested', 'file.txt'), 'utf-8')
    assert.equal(onDisk, 'nested content')
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('writeFile: rejects path traversal', async () => {
  const dir = await tmpDir()
  try {
    await assert.rejects(() => writeFile(dir, '../escape.txt', 'bad'))
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('watchDir: fires onChange with relative path on file change', { timeout: 5000 }, async () => {
  const dir = await tmpDir()
  let watcher: Watcher | undefined
  try {
    await fs.writeFile(path.join(dir, 'watch.txt'), 'initial')

    let report!: (changedPath: string) => void
    const changed = new Promise<string>((resolve) => {
      report = resolve
    })
    watcher = watchDir(dir, { onChange: report, onRemove: () => {} })
    // Only after the initial scan is a write reliably seen as a change.
    await watcher.ready
    await fs.writeFile(path.join(dir, 'watch.txt'), 'updated')

    assert.equal(await changed, 'watch.txt')
  } finally {
    watcher?.close()
    await fs.rm(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// Bounds: node cap, truncation flag, root dot-dirs
// ---------------------------------------------------------------------------

function countNodes(nodes: FileNode[]): number {
  let n = 0
  for (const node of nodes) n += 1 + (node.children ? countNodes(node.children) : 0)
  return n
}

// A session whose cwd is a home directory or a monorepo has tens of
// thousands of nodes; a phone renders a few hundred. The cap is a
// parameter so the test does not need thousands of files.
test('getTree stops at the node cap and says so', async () => {
  const dir = await tmpDir()
  try {
    await fs.mkdir(path.join(dir, 'big'))
    await Promise.all(Array.from({ length: 30 }, (_, i) => fs.writeFile(path.join(dir, 'big', `f${i}`), '')))
    const { entries, truncated } = await getTree(dir, 5, 10)
    assert.equal(countNodes(entries), 10)
    assert.equal(truncated, true)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

// A home directory has .cache, .npm and friends (huge) next to .claude
// (what the user came to read): the skip-list names the heavy ones and
// other dot-directories are shown.
test('files:tree carries the truncation flag, skips the heavy dot-dirs and shows the rest', async () => {
  const dir = await tmpDir()
  const { url, close } = await startTestServer()
  try {
    await fs.mkdir(path.join(dir, '.cache'))
    await fs.writeFile(path.join(dir, '.cache', 'junk'), '')
    await fs.mkdir(path.join(dir, '.npm'))
    await fs.mkdir(path.join(dir, '.claude', 'projects'), { recursive: true })
    await fs.writeFile(path.join(dir, '.claude', 'projects', 'memory.md'), '')
    await fs.mkdir(path.join(dir, 'src', '.hidden'), { recursive: true })
    await fs.writeFile(path.join(dir, 'src', '.hidden', 'kept'), '')
    await fs.writeFile(path.join(dir, '.env'), '')

    const { ws } = await connect(url)
    const reply = waitForType(ws, 'files:tree')
    ws.send(JSON.stringify({ type: 'files:tree', cwd: dir }))
    const msg = await reply
    const entries = msg.entries as FileNode[]

    assert.equal(msg.truncated, false)
    assert.equal(entries.find((n) => n.name === '.cache'), undefined, '.cache is on the skip-list')
    assert.equal(entries.find((n) => n.name === '.npm'), undefined, '.npm is on the skip-list')
    assert.ok(findNode(entries, 'memory.md'), '.claude and its contents are shown')
    assert.ok(entries.find((n) => n.name === '.env'), 'root dot-files stay')
    assert.ok(findNode(entries, '.hidden'), 'dot-dirs below the root stay')
    ws.close()
  } finally {
    await close()
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('getTree reports truncated: false for a small tree', async () => {
  const dir = await tmpDir()
  try {
    await fs.writeFile(path.join(dir, 'a.txt'), 'a')
    assert.deepEqual(await getTree(dir), {
      entries: [{ name: 'a.txt', path: 'a.txt', type: 'file' }],
      truncated: false,
    })
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('writeFile: refuses to write through a symlink at the target, even one inside cwd', async () => {
  const dir = await tmpDir()
  const outside = await tmpDir()
  try {
    const victim = path.join(outside, 'victim.txt')
    await fs.writeFile(victim, 'untouched')
    // realpath containment would catch this one; the O_NOFOLLOW open is
    // for a link dropped in after that check, which a test cannot time.
    // So the link points inside cwd: containment passes, the open must not.
    await fs.writeFile(path.join(dir, 'real.txt'), 'real')
    await fs.symlink(path.join(dir, 'real.txt'), path.join(dir, 'link.txt'))
    await assert.rejects(() => writeFile(dir, 'link.txt', 'through the link'), /symlink/)
    assert.equal(await fs.readFile(path.join(dir, 'real.txt'), 'utf8'), 'real')
    await fs.symlink(victim, path.join(dir, 'escape.txt'))
    await assert.rejects(() => writeFile(dir, 'escape.txt', 'through the link'))
    assert.equal(await fs.readFile(victim, 'utf8'), 'untouched')
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
    await fs.rm(outside, { recursive: true, force: true })
  }
})

test('files:tree and files:watch refuse the filesystem root and kernel directories', async () => {
  const conn = handleTestConnection()
  const roots = ['/', '/proc', '/sys/kernel', '/dev', '/run/../']
  for (const cwd of roots) conn.socket.receive({ type: 'files:tree', cwd })
  conn.socket.receive({ type: 'files:watch', cwd: '/proc/self' })
  await until(() => conn.sent.length === roots.length + 1, 'every reply')
  for (const msg of conn.sent) {
    assert.equal(msg.type, 'error')
    assert.match(String(msg.message), /filesystem root or kernel directories/)
  }
  conn.socket.emit('close')
})

test('files:tree and files:watch reject a relative cwd', async () => {
  const conn = handleTestConnection()
  conn.socket.receive({ type: 'files:tree', cwd: 'relative/dir' })
  conn.socket.receive({ type: 'files:watch', cwd: '../up' })
  await until(() => conn.sent.length === 2, 'both replies')
  for (const msg of conn.sent) {
    assert.equal(msg.type, 'error')
    assert.match(String(msg.message), /must be absolute/)
  }
  conn.socket.emit('close')
})

// ---------------------------------------------------------------------------
// Watching: the ack, deletes, failures
// ---------------------------------------------------------------------------

// chokidar reports inotify's watch limit (ENOSPC) and unreadable
// directories as 'error' events. An EventEmitter with no 'error' listener
// throws on emit, from inside chokidar's fs callback: an unhandled
// rejection, and the server exits.
test('watchDir: a watcher error is logged, not thrown', async () => {
  const dir = await tmpDir()
  const errors: unknown[][] = []
  const logger: Logger = { log: () => {}, error: (...args) => errors.push(args) }
  let fsw: FSWatcher | undefined
  let options: ChokidarOptions | undefined
  const watch: typeof chokidar.watch = (paths, opts) => {
    options = opts
    fsw = chokidar.watch(paths, opts)
    return fsw
  }
  let watcher: Watcher | undefined
  try {
    watcher = watchDir(dir, { onChange: () => {}, onRemove: () => {} }, { logger, watch, maxDepth: 5 })
    await watcher.ready
    assert.ok(fsw)
    const failure = Object.assign(new Error('ENOSPC: System limit for number of file watchers reached'), { code: 'ENOSPC' })
    assert.doesNotThrow(() => fsw!.emit('error', failure))
    assert.equal(errors.length, 1)
    assert.equal(errors[0][1], failure)

    // The walk lists a file under four directories at most (depth 5); the
    // watcher stops there too, and a directory it may not read is skipped
    // rather than reported.
    assert.equal(options?.depth, 4)
    assert.equal(options?.ignorePermissionErrors, true)
  } finally {
    watcher?.close()
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('deleting a watched file produces files:removed, not a logged error', { timeout: 15_000 }, async () => {
  const dir = await tmpDir()
  const conn = handleTestConnection()
  try {
    await fs.writeFile(path.join(dir, 'a.txt'), 'a')
    conn.socket.receive({ type: 'files:watch', cwd: dir })
    // Only after the ack is a change reliably seen.
    await until(() => conn.sent.some((m) => m.type === 'files:watching'), 'the files:watching ack', 10_000)
    assert.deepEqual(conn.sent.find((m) => m.type === 'files:watching'), { type: 'files:watching', cwd: dir })

    await fs.unlink(path.join(dir, 'a.txt'))
    const removed = (): boolean => conn.sent.some((m) => m.type === 'files:removed')
    await until(() => removed() || conn.errors.length > 0, 'the watcher to react to the delete', 3000)

    assert.deepEqual(conn.errors, [], 'the delete was logged as an error instead of reported')
    assert.deepEqual(conn.sent.find((m) => m.type === 'files:removed'), { type: 'files:removed', path: 'a.txt' })
  } finally {
    conn.socket.emit('close')
    await fs.rm(dir, { recursive: true, force: true })
  }
})
