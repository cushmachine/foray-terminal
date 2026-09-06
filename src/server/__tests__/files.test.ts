// Filesystem API (getTree, readFile, writeFile, watchDir) tests.
//
// Run with: npm run test:files
// (executed directly via `tsx`, using node's built-in test runner)
//
// These tests use real filesystem operations on temp directories — no
// mocking needed. Each test creates its own temp dir and cleans it up in a
// finally block.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { getTree, readFile, writeFile, watchDir } from '../files.ts'
import type { FileNode } from '../../shared/protocol.ts'

async function makeTmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'nest-test-'))
}

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
  const tmpDir = await makeTmpDir()
  try {
    await fs.writeFile(path.join(tmpDir, 'a.txt'), 'a')
    await fs.writeFile(path.join(tmpDir, 'b.md'), 'b')
    await fs.mkdir(path.join(tmpDir, 'sub', 'deep'), { recursive: true })
    await fs.writeFile(path.join(tmpDir, 'sub', 'c.ts'), 'c')
    await fs.writeFile(path.join(tmpDir, 'sub', 'deep', 'd.json'), 'd')

    const tree = await getTree(tmpDir)

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
    await fs.rm(tmpDir, { recursive: true, force: true })
  }
})

test('getTree: respects .gitignore', async () => {
  const tmpDir = await makeTmpDir()
  try {
    await fs.writeFile(path.join(tmpDir, 'keep.txt'), 'keep')
    await fs.writeFile(path.join(tmpDir, 'ignored.log'), 'ignored')
    await fs.writeFile(path.join(tmpDir, '.gitignore'), '*.log\n')

    const tree = await getTree(tmpDir)
    const names = collectNames(tree)

    assert.ok(!names.includes('ignored.log'), 'ignored.log should be filtered out')
    assert.ok(names.includes('keep.txt'), 'keep.txt should remain')
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true })
  }
})

test('getTree: always skips node_modules, .git, dist, .DS_Store', async () => {
  const tmpDir = await makeTmpDir()
  try {
    await fs.mkdir(path.join(tmpDir, 'src'), { recursive: true })
    await fs.writeFile(path.join(tmpDir, 'src', 'a.ts'), 'a')
    await fs.mkdir(path.join(tmpDir, 'node_modules', 'pkg'), { recursive: true })
    await fs.writeFile(path.join(tmpDir, 'node_modules', 'pkg', 'index.js'), '')
    await fs.mkdir(path.join(tmpDir, '.git'), { recursive: true })
    await fs.writeFile(path.join(tmpDir, '.git', 'HEAD'), '')
    await fs.mkdir(path.join(tmpDir, 'dist'), { recursive: true })
    await fs.writeFile(path.join(tmpDir, 'dist', 'bundle.js'), '')
    await fs.writeFile(path.join(tmpDir, '.DS_Store'), '')

    const tree = await getTree(tmpDir)
    const names = collectNames(tree)

    assert.ok(!names.includes('node_modules'))
    assert.ok(!names.includes('.git'))
    assert.ok(!names.includes('dist'))
    assert.ok(!names.includes('.DS_Store'))
    assert.ok(names.includes('src'))
    assert.ok(names.includes('a.ts'))
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true })
  }
})

test('getTree: respects maxDepth', async () => {
  const tmpDir = await makeTmpDir()
  try {
    await fs.mkdir(path.join(tmpDir, 'a', 'b', 'c', 'd', 'e', 'f'), { recursive: true })
    await fs.writeFile(path.join(tmpDir, 'a', 'b', 'c', 'd', 'e', 'f', 'deep.txt'), 'deep')

    const tree = await getTree(tmpDir, 3)
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
    await fs.rm(tmpDir, { recursive: true, force: true })
  }
})

test('readFile: reads file contents', async () => {
  const tmpDir = await makeTmpDir()
  try {
    await fs.writeFile(path.join(tmpDir, 'hello.txt'), 'hello world')
    const content = await readFile(tmpDir, 'hello.txt')
    assert.equal(content, 'hello world')
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true })
  }
})

test('readFile: rejects path traversal', async () => {
  const tmpDir = await makeTmpDir()
  try {
    await assert.rejects(() => readFile(tmpDir, '../etc/passwd'))
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true })
  }
})

test('readFile: rejects absolute paths', async () => {
  const tmpDir = await makeTmpDir()
  try {
    await assert.rejects(() => readFile(tmpDir, '/etc/passwd'))
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true })
  }
})

test('writeFile: writes and reads back', async () => {
  const tmpDir = await makeTmpDir()
  try {
    await writeFile(tmpDir, 'output.txt', 'written content')
    const onDisk = await fs.readFile(path.join(tmpDir, 'output.txt'), 'utf-8')
    assert.equal(onDisk, 'written content')
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true })
  }
})

test('writeFile: creates parent directories', async () => {
  const tmpDir = await makeTmpDir()
  try {
    await writeFile(tmpDir, 'new/nested/file.txt', 'nested content')
    const onDisk = await fs.readFile(path.join(tmpDir, 'new', 'nested', 'file.txt'), 'utf-8')
    assert.equal(onDisk, 'nested content')
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true })
  }
})

test('writeFile: rejects path traversal', async () => {
  const tmpDir = await makeTmpDir()
  try {
    await assert.rejects(() => writeFile(tmpDir, '../escape.txt', 'bad'))
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true })
  }
})

test('watchDir: fires onChange with relative path on file change', async () => {
  const tmpDir = await makeTmpDir()
  let watcher: { close(): void } | undefined
  try {
    await fs.writeFile(path.join(tmpDir, 'watch.txt'), 'initial')

    const changed = new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('timed out waiting for onChange')), 5000)
      watcher = watchDir(tmpDir, (changedPath) => {
        clearTimeout(timeout)
        resolve(changedPath)
      })
    })

    // Give chokidar a moment to finish its initial scan before we mutate
    // the file, so the write is reliably picked up as a 'change' event.
    await new Promise((resolve) => setTimeout(resolve, 500))
    await fs.writeFile(path.join(tmpDir, 'watch.txt'), 'updated')

    const changedPath = await changed
    assert.equal(changedPath, 'watch.txt')
  } finally {
    watcher?.close()
    await fs.rm(tmpDir, { recursive: true, force: true })
  }
})
