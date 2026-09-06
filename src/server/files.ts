// Filesystem operations for Nest.
//
// Backs the files:tree / files:read / files:write / files:watch protocol
// messages defined in src/shared/protocol.ts.

import fs from 'node:fs/promises'
import path from 'node:path'
import chokidar from 'chokidar'
import type { FileNode } from '../shared/protocol.ts'

/** Directory/file names that are always excluded from the tree and watcher, regardless of .gitignore. */
const ALWAYS_SKIP = new Set(['node_modules', '.git', 'dist', '.DS_Store'])

const DEFAULT_MAX_DEPTH = 5

// ---------------------------------------------------------------------------
// .gitignore parsing (simple subset — see module doc in the task spec)
// ---------------------------------------------------------------------------

interface GitignoreRule {
  regex: RegExp
  dirOnly: boolean
  negate: boolean
}

interface GitignoreMatcher {
  /** True if the given path (relative to the gitignore's root, POSIX-separated) should be ignored. */
  isIgnored(relPath: string, isDir: boolean): boolean
}

/** Convert a simple gitignore glob (only `*` is treated specially) into an anchored RegExp. */
function globToRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')
  return new RegExp(`^${escaped}$`)
}

function parseGitignoreLine(rawLine: string): GitignoreRule | undefined {
  let line = rawLine.trim()
  if (!line || line.startsWith('#')) return undefined

  let negate = false
  if (line.startsWith('!')) {
    negate = true
    line = line.slice(1)
  }

  let dirOnly = false
  if (line.endsWith('/')) {
    dirOnly = true
    line = line.slice(0, -1)
  }

  // A leading slash anchors to the gitignore's directory. Since we already
  // match both the basename and the full relative path, stripping it is
  // enough to support the common `/dist`-style anchored pattern.
  if (line.startsWith('/')) {
    line = line.slice(1)
  }

  if (!line) return undefined

  return { regex: globToRegex(line), dirOnly, negate }
}

async function loadGitignore(root: string): Promise<GitignoreMatcher> {
  let rules: GitignoreRule[] = []
  try {
    const content = await fs.readFile(path.join(root, '.gitignore'), 'utf-8')
    rules = content
      .split(/\r?\n/)
      .map(parseGitignoreLine)
      .filter((rule): rule is GitignoreRule => rule !== undefined)
  } catch {
    // No .gitignore present (or unreadable) — nothing to filter.
  }

  return {
    isIgnored(relPath: string, isDir: boolean): boolean {
      if (rules.length === 0) return false
      const basename = path.posix.basename(relPath)
      let ignored = false
      for (const rule of rules) {
        if (rule.dirOnly && !isDir) continue
        if (rule.regex.test(basename) || rule.regex.test(relPath)) {
          ignored = !rule.negate
        }
      }
      return ignored
    },
  }
}

// ---------------------------------------------------------------------------
// getTree
// ---------------------------------------------------------------------------

/** Normalize a filesystem-relative path to forward slashes, regardless of platform. */
function toPosixPath(relPath: string): string {
  return relPath.split(path.sep).join('/')
}

async function walk(
  root: string,
  dir: string,
  depth: number,
  maxDepth: number,
  gitignore: GitignoreMatcher,
): Promise<FileNode[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true })
  const nodes: FileNode[] = []

  for (const entry of entries) {
    if (ALWAYS_SKIP.has(entry.name)) continue

    const isDir = entry.isDirectory()
    const isFile = entry.isFile()
    if (!isDir && !isFile) continue // skip symlinks, sockets, etc.

    const fullPath = path.join(dir, entry.name)
    const relPath = toPosixPath(path.relative(root, fullPath))

    if (gitignore.isIgnored(relPath, isDir)) continue

    if (isDir) {
      const children = depth < maxDepth ? await walk(root, fullPath, depth + 1, maxDepth, gitignore) : []
      nodes.push({ name: entry.name, path: relPath, type: 'dir', children })
    } else {
      nodes.push({ name: entry.name, path: relPath, type: 'file' })
    }
  }

  nodes.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'dir' ? -1 : 1
    return a.name.localeCompare(b.name)
  })

  return nodes
}

/**
 * Recursively list the directory tree rooted at `cwd`.
 *
 * - Respects a top-level .gitignore (if present) using a simplified matcher.
 * - Always skips node_modules, .git, dist, .DS_Store, regardless of .gitignore.
 * - Directories are sorted before files; each group is alphabetical.
 * - `maxDepth` (default 5) bounds recursion: directories at the max depth
 *   are still listed, but their contents are not read.
 */
export async function getTree(cwd: string, maxDepth: number = DEFAULT_MAX_DEPTH): Promise<FileNode[]> {
  const root = path.resolve(cwd)
  const gitignore = await loadGitignore(root)
  return walk(root, root, 1, maxDepth, gitignore)
}

// ---------------------------------------------------------------------------
// readFile / writeFile
// ---------------------------------------------------------------------------

/**
 * Resolve `relativePath` against `cwd`, rejecting anything that looks like a
 * path traversal or escapes `cwd` once resolved (including via symlinks).
 */
async function resolveSafePath(cwd: string, relativePath: string): Promise<string> {
  if (relativePath.startsWith('/')) {
    throw new Error(`Invalid path (absolute paths are not allowed): ${relativePath}`)
  }
  if (relativePath.includes('..')) {
    throw new Error(`Invalid path (path traversal is not allowed): ${relativePath}`)
  }

  const root = path.resolve(cwd)
  const resolved = path.resolve(root, relativePath)

  const rel = path.relative(root, resolved)
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Invalid path (escapes cwd): ${relativePath}`)
  }

  // Follow symlinks to prevent a symlink inside cwd pointing outside it
  // from bypassing the textual containment check above.
  const realRoot = await fs.realpath(root)
  try {
    const realResolved = await fs.realpath(resolved)
    const realRel = path.relative(realRoot, realResolved)
    if (realRel.startsWith('..') || path.isAbsolute(realRel)) {
      throw new Error(`Invalid path (escapes cwd via symlink): ${relativePath}`)
    }
  } catch (err) {
    // File or parent dirs might not exist yet (writes to new nested paths).
    // Walk up to the nearest existing ancestor and verify it's inside cwd.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      let check = path.dirname(resolved)
      while (check !== root && check !== path.dirname(check)) {
        try {
          const realCheck = await fs.realpath(check)
          const checkRel = path.relative(realRoot, realCheck)
          if (checkRel.startsWith('..') || path.isAbsolute(checkRel)) {
            throw new Error(`Invalid path (escapes cwd via symlink): ${relativePath}`)
          }
          break
        } catch (inner) {
          if ((inner as NodeJS.ErrnoException).code !== 'ENOENT') throw inner
          check = path.dirname(check)
        }
      }
    } else {
      throw err
    }
  }

  return resolved
}

const MAX_FILE_SIZE = 1024 * 1024 // 1MB

/** Read a file's contents as utf-8. `relativePath` is resolved against, and must stay within, `cwd`. */
export async function readFile(cwd: string, relativePath: string): Promise<string> {
  const resolved = await resolveSafePath(cwd, relativePath)
  const { size } = await fs.stat(resolved)
  if (size > MAX_FILE_SIZE) {
    throw new Error(`File too large (${(size / 1024 / 1024).toFixed(1)}MB, max 1MB)`)
  }
  return fs.readFile(resolved, 'utf-8')
}

/** Write a file's contents as utf-8, creating parent directories as needed. Same safety checks as readFile. */
export async function writeFile(cwd: string, relativePath: string, content: string): Promise<void> {
  const resolved = await resolveSafePath(cwd, relativePath)
  await fs.mkdir(path.dirname(resolved), { recursive: true })
  await fs.writeFile(resolved, content, 'utf-8')
}

// ---------------------------------------------------------------------------
// watchDir
// ---------------------------------------------------------------------------

export interface Watcher {
  close(): void
}

const WATCH_DEBOUNCE_MS = 300

/**
 * Watch `cwd` recursively for file changes, debounced 300ms per file.
 * `onChange` receives the changed file's path relative to `cwd`.
 */
export function watchDir(cwd: string, onChange: (path: string) => void): Watcher {
  const root = path.resolve(cwd)
  const timers = new Map<string, NodeJS.Timeout>()

  const watcher = chokidar.watch(root, {
    ignoreInitial: true,
    ignored: (filePath: string) => {
      const rel = path.relative(root, filePath)
      if (rel === '') return false
      return rel.split(path.sep).some((segment) => ALWAYS_SKIP.has(segment))
    },
  })

  const handleEvent = (filePath: string) => {
    const relPath = toPosixPath(path.relative(root, filePath))

    const existing = timers.get(relPath)
    if (existing) clearTimeout(existing)

    const timer = setTimeout(() => {
      timers.delete(relPath)
      onChange(relPath)
    }, WATCH_DEBOUNCE_MS)
    timers.set(relPath, timer)
  }

  watcher.on('add', handleEvent)
  watcher.on('change', handleEvent)
  watcher.on('unlink', handleEvent)

  return {
    close(): void {
      for (const timer of timers.values()) clearTimeout(timer)
      timers.clear()
      void watcher.close()
    },
  }
}
