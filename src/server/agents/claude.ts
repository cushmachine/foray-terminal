// Claude Code as an agent provider: its transcripts, its live-session
// markers and its resume command. The only file in Foray that knows what
// ~/.claude looks like.
//
// Transcripts are one JSONL file per session under
// <dir>/projects/<encoded cwd>/<uuid>.jsonl. Only the top level of each
// project dir counts: subfolders hold tool results and subagent
// transcripts. The project dir name is a lossy encoding of the path, so
// the cwd is taken from inside the file. Every user/assistant line carries
// cwd, gitBranch, timestamp and isSidechain; a repeating
// {"type":"ai-title"} line carries the agent's own title for the session
// and {"type":"last-prompt"} the user's latest ask. Both repeat each turn,
// so the last one in the file is current, and the tail of the file is
// enough to find them. Sessions never get an ai-title at all when they
// were short, so the opening prompt is the fallback.
//
// Live sessions are <dir>/sessions/<pid>.json, one per running process,
// left behind when a process dies without cleaning up (a crash, an OOM).
// A marker counts only while its pid is alive.

import fs from 'node:fs/promises'
import path from 'node:path'
import type { AgentProvider, AgentSession, LiveSession } from './types.ts'

export const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/**
 * How much of the start of a transcript to read looking for the opening
 * prompt. A file can begin with a large file-history snapshot, so this is
 * generous; the scan stops at the first user prompt regardless.
 */
const HEAD_BYTES = 1024 * 1024
/** How much of the end to read for the current title and last prompt. */
const TAIL_BYTES = 64 * 1024
/** Longest title made from an opening prompt. */
const TITLE_CHARS = 80

export interface ClaudeProviderOptions {
  /** The Claude data directory, normally ~/.claude. */
  dir: string
  /** Extra arguments placed before --resume, e.g. ['--model', 'x']. */
  args?: string[]
  /** Whether a pid is running; injectable for tests. */
  pidAlive?: (pid: number) => boolean
}

export interface HeadInfo {
  cwd?: string
  branch?: string
  prompt?: string
  /** True once a user line was seen, prompt or not: the session is not empty. */
  hasUser: boolean
}

export interface TailInfo {
  title?: string
  lastPrompt?: string
  branch?: string
}

/** Parse one JSONL line; null for a partial or malformed one. */
function parseLine(line: string): Record<string, unknown> | null {
  if (!line.startsWith('{')) return null
  try {
    return JSON.parse(line) as Record<string, unknown>
  } catch {
    return null
  }
}

/** The user's text from a user line's message, or undefined for a tool-result-only line. */
function userText(message: unknown): string | undefined {
  if (typeof message !== 'object' || message === null) return undefined
  const content = (message as { content?: unknown }).content
  if (typeof content === 'string') return content.trim() || undefined
  if (!Array.isArray(content)) return undefined
  for (const block of content) {
    if (typeof block === 'object' && block !== null && (block as { type?: unknown }).type === 'text') {
      const text = (block as { text?: unknown }).text
      if (typeof text === 'string' && text.trim()) return text.trim()
    }
  }
  return undefined
}

/**
 * What the start of a transcript says: the cwd and branch from the first
 * conversation line, and the opening prompt. Stops as soon as it has all
 * three. Sidechain lines are subagent traffic, not the user's.
 */
export function parseHead(text: string): HeadInfo {
  const info: HeadInfo = { hasUser: false }
  for (const line of text.split('\n')) {
    const obj = parseLine(line)
    if (!obj || obj.isSidechain === true) continue
    if (obj.type !== 'user' && obj.type !== 'assistant') continue
    if (info.cwd === undefined && typeof obj.cwd === 'string') info.cwd = obj.cwd
    if (info.branch === undefined && typeof obj.gitBranch === 'string') info.branch = obj.gitBranch
    if (obj.type === 'user') {
      info.hasUser = true
      if (info.prompt === undefined) info.prompt = userText(obj.message)
    }
    if (info.cwd !== undefined && info.prompt !== undefined) break
  }
  return info
}

/**
 * What the end of a transcript says: the latest title and last prompt.
 * The first line of a tail chunk is usually cut mid-JSON and is skipped by
 * the parser. Later lines win over earlier ones.
 */
export function parseTail(text: string): TailInfo {
  const info: TailInfo = {}
  for (const line of text.split('\n')) {
    const obj = parseLine(line)
    if (!obj) continue
    if (obj.type === 'ai-title' && typeof obj.aiTitle === 'string' && obj.aiTitle.trim()) info.title = obj.aiTitle.trim()
    if (obj.type === 'last-prompt' && typeof obj.lastPrompt === 'string') info.lastPrompt = obj.lastPrompt.trim()
    if (typeof obj.gitBranch === 'string') info.branch = obj.gitBranch
  }
  return info
}

/** A title from an opening prompt: first line, trimmed to TITLE_CHARS. */
function titleFromPrompt(prompt: string): string {
  const first = prompt.split('\n')[0].trim()
  return first.length > TITLE_CHARS ? `${first.slice(0, TITLE_CHARS - 1)}…` : first
}

async function readRange(file: string, start: number, length: number): Promise<string> {
  const handle = await fs.open(file, 'r')
  try {
    const buffer = Buffer.alloc(length)
    const { bytesRead } = await handle.read(buffer, 0, length, start)
    return buffer.toString('utf8', 0, bytesRead)
  } finally {
    await handle.close()
  }
}

interface CacheEntry {
  mtimeMs: number
  size: number
  session: AgentSession | null
}

const defaultPidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    // EPERM means it exists but belongs to someone else: still alive.
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export function claudeProvider(options: ClaudeProviderOptions): AgentProvider {
  const { dir, args = [], pidAlive = defaultPidAlive } = options
  const projectsDir = path.join(dir, 'projects')
  const sessionsDir = path.join(dir, 'sessions')
  const cache = new Map<string, CacheEntry>()

  /** Parse one transcript, or null when it holds no conversation. */
  async function parseTranscript(file: string, size: number, mtimeMs: number): Promise<AgentSession | null> {
    const id = path.basename(file, '.jsonl')
    const head = parseHead(await readRange(file, 0, Math.min(size, HEAD_BYTES)))
    if (!head.hasUser || head.cwd === undefined) return null
    const tailStart = Math.max(0, size - TAIL_BYTES)
    const tail = tailStart === 0 ? parseTail(await readRange(file, 0, size)) : parseTail(await readRange(file, tailStart, TAIL_BYTES))
    const title = tail.title ?? (head.prompt !== undefined ? titleFromPrompt(head.prompt) : '')
    if (!title) return null
    return {
      id,
      title,
      lastPrompt: tail.lastPrompt ?? '',
      cwd: head.cwd,
      branch: tail.branch ?? head.branch ?? '',
      lastActive: mtimeMs,
    }
  }

  async function transcriptFiles(): Promise<string[]> {
    let projects: string[]
    try {
      projects = await fs.readdir(projectsDir)
    } catch {
      return []
    }
    const files: string[] = []
    for (const project of projects) {
      const projectDir = path.join(projectsDir, project)
      let entries: import('node:fs').Dirent[]
      try {
        entries = await fs.readdir(projectDir, { withFileTypes: true })
      } catch {
        continue
      }
      for (const entry of entries) {
        if (entry.isFile() && entry.name.endsWith('.jsonl') && SESSION_ID_RE.test(entry.name.slice(0, -6))) {
          files.push(path.join(projectDir, entry.name))
        }
      }
    }
    return files
  }

  return {
    id: 'claude',
    label: 'Claude Code',
    isSessionId: (id) => SESSION_ID_RE.test(id),

    async scan() {
      const files = await transcriptFiles()
      const seen = new Set<string>()
      // The same session can sit under two project dirs when a repo was
      // moved; the copy left behind is a stub. Keep the fullest one.
      const best = new Map<string, { size: number; session: AgentSession }>()
      for (const file of files) {
        seen.add(file)
        let stat
        try {
          stat = await fs.stat(file)
        } catch {
          continue
        }
        let entry = cache.get(file)
        if (!entry || entry.mtimeMs !== stat.mtimeMs || entry.size !== stat.size) {
          let session: AgentSession | null = null
          try {
            session = await parseTranscript(file, stat.size, stat.mtimeMs)
          } catch {
            session = null
          }
          entry = { mtimeMs: stat.mtimeMs, size: stat.size, session }
          cache.set(file, entry)
        }
        if (!entry.session) continue
        const current = best.get(entry.session.id)
        if (!current || current.size < entry.size) best.set(entry.session.id, { size: entry.size, session: entry.session })
      }
      for (const file of cache.keys()) if (!seen.has(file)) cache.delete(file)
      return [...best.values()].map((b) => b.session)
    },

    async live() {
      let names: string[]
      try {
        names = await fs.readdir(sessionsDir)
      } catch {
        return []
      }
      const live: LiveSession[] = []
      for (const name of names) {
        if (!name.endsWith('.json')) continue
        let marker: { pid?: unknown; sessionId?: unknown; tmux?: unknown }
        try {
          marker = JSON.parse(await fs.readFile(path.join(sessionsDir, name), 'utf8'))
        } catch {
          continue
        }
        if (typeof marker.pid !== 'number' || typeof marker.sessionId !== 'string') continue
        if (!pidAlive(marker.pid)) continue
        const entry: LiveSession = { id: marker.sessionId }
        // "foray_bash:@0.%0" is session:window.pane, as of when the process
        // started; the session may have been renamed since, the window id not.
        if (typeof marker.tmux === 'string' && marker.tmux) {
          const [session, rest = ''] = marker.tmux.split(':')
          if (session) entry.tmuxSession = session
          const windowId = rest.split('.')[0]
          if (/^@\d+$/.test(windowId)) entry.tmuxWindow = windowId
        }
        live.push(entry)
      }
      return live
    },

    resumeCommand: (id) => ['claude', ...args, '--resume', id],
  }
}
