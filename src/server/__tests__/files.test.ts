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
import { getTree, readFile, writeFile, watchDir, type Watcher } from '../files.ts'
import type { FileNode } from '../../shared/protocol.ts'
import { tmpDir } from './helpers.ts'

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

    const tree = await getTree(dir)

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

    const tree = await getTree(dir)
    const names = collectNames(tree)

    assert.ok(!names.includes('ignored.log'), 'ignored.log should be filtered out')
    assert.ok(names.includes('keep.txt'), 'keep.txt should remain')
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('getTree: always skips node_modules, .git, dist, .DS_Store', async () => {
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

    const tree = await getTree(dir)
    const names = collectNames(tree)

    assert.ok(!names.includes('node_modules'))
    assert.ok(!names.includes('.git'))
    assert.ok(!names.includes('dist'))
    assert.ok(!names.includes('.DS_Store'))
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

    const tree = await getTree(dir, 3)
    const names = collectNames(tree)

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
    watcher = watchDir(dir, report)
    // Only after the initial scan is a write reliably seen as a change.
    await watcher.ready
    await fs.writeFile(path.join(dir, 'watch.txt'), 'updated')

    assert.equal(await changed, 'watch.txt')
  } finally {
    watcher?.close()
    await fs.rm(dir, { recursive: true, force: true })
  }
})
