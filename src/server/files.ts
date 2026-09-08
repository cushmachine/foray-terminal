// Filesystem operations for Nest.
//
// Backs the files:tree / files:read / files:write / files:watch protocol
// messages defined in src/shared/protocol.ts.

import fs from 'node:fs/promises'
import path from 'node:path'
import chokidar from 'chokidar'
import type { FileNode } from '../shared/protocol.ts'
import { ClientError } from './errors.ts'

/** Directory/file names that are always excluded from the tree and watcher, regardless of .gitignore. */
const ALWAYS_SKIP = new Set(['node_modules', '.git', 'dist', '.DS_Store'])

const DEFAULT_MAX_DEPTH = 5

/**
 * Most nodes a tree response carries. A session whose cwd is a home
 * directory or a monorepo has far more, and a phone renders a few hundred;
 * past this the walk stops and the response says it was cut short.
 */
export const MAX_TREE_NODES = 5000

/**
 * The directory a files:* request is about. Clients send the session's
 * cwd as tmux reports it, which is absolute; anything else has no sensible
 * base to resolve against.
 */
export function resolveRoot(cwd: string): string {
  if (!path.isAbsolute(cwd)) throw new ClientError('Invalid path (cwd must be absolute)')
  return path.normalize(cwd)
}

/**
 * Whether the tree and the watcher leave `fullPath` (under `root`) out.
 * Beyond ALWAYS_SKIP anywhere in the path, dot-directories directly under
 * the root are skipped (.cache, .npm, .local under a home directory) along
 * with everything inside them; dot-files at the root (.gitignore, .env)
 * stay. `isDir` is unknown on chokidar's first look at a path; it asks
 * again with stats before watching it.
 */
function isSkipped(root: string, fullPath: string, isDir: boolean | undefined): boolean {
  const rel = path.relative(root, fullPath)
  if (rel === '') return false
  const segments = rel.split(path.sep)
  if (segments.some((segment) => ALWAYS_SKIP.has(segment))) return true
  if (segments[0].startsWith('.')) {
    if (segments.length > 1) return true
    if (isDir) return true
  }
  return false
}

// ---------------------------------------------------------------------------
// .gitignore parsing: a small subset (`*` globs matched against the basename and the relative path, trailing / for directories, ! negation)
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

/** Nodes still allowed into one tree response, shared across the walk. */
interface Budget {
  left: number
  truncated: boolean
}

async function walk(
  root: string,
  dir: string,
  depth: number,
  maxDepth: number,
  gitignore: GitignoreMatcher,
  budget: Budget,
): Promise<FileNode[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true })
  const nodes: FileNode[] = []

  for (const entry of entries) {
    const isDir = entry.isDirectory()
    const isFile = entry.isFile()
    if (!isDir && !isFile) continue // skip symlinks, sockets, etc.

    const fullPath = path.join(dir, entry.name)
    if (isSkipped(root, fullPath, isDir)) continue
    const relPath = toPosixPath(path.relative(root, fullPath))

    if (gitignore.isIgnored(relPath, isDir)) continue

    if (budget.left === 0) {
      budget.truncated = true
      break
    }
    budget.left--

    if (isDir) {
      const children = depth < maxDepth ? await walk(root, fullPath, depth + 1, maxDepth, gitignore, budget) : []
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

export interface Tree {
  entries: FileNode[]
  /** The walk hit `maxNodes` and stopped; the listing is partial. */
  truncated: boolean
}

/**
 * Recursively list the directory tree rooted at `cwd`.
 *
 * - Respects a top-level .gitignore (if present) using a simplified matcher.
 * - Always skips node_modules, .git, dist, .DS_Store, regardless of
 *   .gitignore, and dot-directories directly under the root.
 * - Directories are sorted before files; each group is alphabetical.
 * - `maxDepth` (default 5) bounds recursion: directories at the max depth
 *   are still listed, but their contents are not read.
 * - Stops after `maxNodes` nodes and reports `truncated`.
 */
export async function getTree(
  cwd: string,
  maxDepth: number = DEFAULT_MAX_DEPTH,
  maxNodes: number = MAX_TREE_NODES,
): Promise<Tree> {
  const root = path.resolve(cwd)
  const gitignore = await loadGitignore(root)
  const budget: Budget = { left: maxNodes, truncated: false }
  const entries = await walk(root, root, 1, maxDepth, gitignore, budget)
  return { entries, truncated: budget.truncated }
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
    throw new ClientError(`Invalid path (absolute paths are not allowed): ${relativePath}`)
  }
  if (relativePath.includes('..')) {
    throw new ClientError(`Invalid path (path traversal is not allowed): ${relativePath}`)
  }

  const root = path.resolve(cwd)
  const resolved = path.resolve(root, relativePath)

  const rel = path.relative(root, resolved)
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new ClientError(`Invalid path (escapes cwd): ${relativePath}`)
  }

  // Follow symlinks to prevent a symlink inside cwd pointing outside it
  // from bypassing the textual containment check above.
  const realRoot = await fs.realpath(root)
  try {
    const realResolved = await fs.realpath(resolved)
    const realRel = path.relative(realRoot, realResolved)
    if (realRel.startsWith('..') || path.isAbsolute(realRel)) {
      throw new ClientError(`Invalid path (escapes cwd via symlink): ${relativePath}`)
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
            throw new ClientError(`Invalid path (escapes cwd via symlink): ${relativePath}`)
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
    throw new ClientError(`File too large (${(size / 1024 / 1024).toFixed(1)}MB, max 1MB)`)
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
  /** Resolves once the initial scan is done and changes are being reported. */
  ready: Promise<void>
}

export interface WatchEvents {
  /** A file under the root was created or written; the path is relative to it. */
  onChange: (path: string) => void
  /** A file under the root was deleted. */
  onRemove: (path: string) => void
}

const WATCH_DEBOUNCE_MS = 300

/**
 * Watch `cwd` recursively for file changes, debounced 300ms per file: a
 * burst of events on one path is reported once, as whatever happened last.
 */
export function watchDir(cwd: string, events: WatchEvents): Watcher {
  const root = path.resolve(cwd)
  const pending = new Map<string, { timer: NodeJS.Timeout; kind: 'change' | 'remove' }>()

  const watcher = chokidar.watch(root, {
    ignoreInitial: true,
    ignored: (filePath: string, stats?: { isDirectory(): boolean }) =>
      isSkipped(root, filePath, stats?.isDirectory()),
  })

  const handleEvent = (kind: 'change' | 'remove') => (filePath: string) => {
    const relPath = toPosixPath(path.relative(root, filePath))
    const existing = pending.get(relPath)
    if (existing) clearTimeout(existing.timer)
    const timer = setTimeout(() => {
      const entry = pending.get(relPath)
      pending.delete(relPath)
      if (entry?.kind === 'remove') events.onRemove(relPath)
      else events.onChange(relPath)
    }, WATCH_DEBOUNCE_MS)
    pending.set(relPath, { timer, kind })
  }

  watcher.on('add', handleEvent('change'))
  watcher.on('change', handleEvent('change'))
  watcher.on('unlink', handleEvent('remove'))
  const ready = new Promise<void>((resolve) => watcher.once('ready', resolve))

  return {
    ready,
    close(): void {
      for (const { timer } of pending.values()) clearTimeout(timer)
      pending.clear()
      void watcher.close()
    },
  }
}
