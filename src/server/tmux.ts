// Tmux CLI wrapper for Nest.
//
// Each Nest "session" is its own tmux session (not a window within one
// session). This avoids shared views and size-mismatch artifacts when
// multiple terminals are open. Sessions are named with a "nest_" prefix.

import { execFile as _execFile } from 'node:child_process'
import os from 'node:os'
import { promisify } from 'node:util'
import type { TmuxWindow } from '../shared/protocol.ts'

const promisedExecFile = promisify(_execFile)

/** Signature for the tmux command executor, injectable for testing. */
export type TmuxExecutor = (
  cmd: string,
  args: string[],
) => Promise<{ stdout: string; stderr: string }>

const defaultExec: TmuxExecutor = (cmd, args) => promisedExecFile(cmd, args)

const PREFIX = 'nest_'

/**
 * Session user option stamped once the user has explicitly named a session
 * (at create or rename). Lets the UI prefer that name over whatever title
 * the running program sets. Lives in tmux, so it survives Nest restarts.
 */
const NAMED_OPTION = '@nest_named'

/**
 * Field separator for `-F` formats. Pane titles and paths can contain
 * spaces, so split on a control character neither will contain.
 */
export const SEP = '\x1f'

/** Format string shared by list-sessions and new-session -P. */
const FORMAT = [
  '#{session_id}',
  '#{session_name}',
  '#{pane_current_path}',
  '#{pane_title}',
  '#{pane_current_command}',
  `#{${NAMED_OPTION}}`,
].join(SEP)

/**
 * Foreground commands under which a pane title carries no information: a
 * program's title outlives the program (tmux never resets it), so once a
 * bare shell is back in front the title is just stale.
 */
const SHELLS = new Set(['bash', 'zsh', 'sh', 'fish', 'dash'])

/**
 * Parse one FORMAT line, e.g. `$5<SEP>nest_shell<SEP>/root<SEP>nest<SEP>bash<SEP>`.
 * Only returns sessions with the "nest_" prefix.
 *
 * `hostname` is what tmux initialises every pane title to; such a title is
 * reported as empty so the UI falls back to the session name.
 */
function parseLine(line: string, hostname: string): TmuxWindow | null {
  const [rawId, rawName, cwd, rawTitle = '', command = '', named = ''] = line.split(SEP)
  const idMatch = rawId?.match(/^\$(\d+)$/)
  if (!idMatch || !rawName || cwd === undefined) return null
  if (!rawName.startsWith(PREFIX)) return null

  const titleIsMeaningful = rawTitle !== '' && rawTitle !== hostname && !SHELLS.has(command)
  return {
    id: parseInt(idMatch[1], 10),
    name: rawName.slice(PREFIX.length),
    cwd,
    title: titleIsMeaningful ? rawTitle : '',
    command,
    named: named === '1',
  }
}

/**
 * List all Nest sessions (tmux sessions with the "nest_" prefix).
 * Returns [] if tmux is not running or no Nest sessions exist.
 */
export async function listWindows(
  exec: TmuxExecutor = defaultExec,
  hostname: string = os.hostname(),
): Promise<TmuxWindow[]> {
  try {
    const { stdout } = await exec('tmux', ['list-sessions', '-F', FORMAT])
    if (!stdout.trim()) return []
    return stdout
      .trim()
      .split('\n')
      .map((line) => parseLine(line, hostname))
      .filter((w): w is TmuxWindow => w !== null)
  } catch {
    return []
  }
}

/**
 * Create a new Nest session. Each session is its own tmux session with
 * one window and the status bar disabled.
 */
export async function createWindow(
  name?: string,
  cwd?: string,
  exec: TmuxExecutor = defaultExec,
  hostname: string = os.hostname(),
): Promise<TmuxWindow> {
  const displayName = name || 'bash'
  let sessionName = `${PREFIX}${displayName}`

  // Handle name collisions by appending a number.
  let attempt = 0
  while (attempt <= 20) {
    const actualName = attempt === 0 ? sessionName : `${sessionName}-${attempt}`
    const args = [
      'new-session', '-d',
      '-s', actualName,
      '-P', '-F', FORMAT,
    ]
    // Always pass a start directory. Without -c, tmux uses the cwd of the
    // process that ran the command, i.e. the Nest server itself (the nest
    // repo under PM2), which is never where a new session should start.
    args.push('-c', cwd || os.homedir())

    try {
      const { stdout } = await exec('tmux', args)

      // Hide the tmux status bar so it doesn't render inside xterm.js.
      await exec('tmux', ['set', '-t', actualName, 'status', 'off']).catch(() => {})
      if (name) {
        await exec('tmux', ['set', '-t', actualName, NAMED_OPTION, '1']).catch(() => {})
      }

      const parsed = parseLine(stdout.trim(), hostname)
      if (!parsed) throw new Error(`Failed to parse new session output: ${stdout}`)
      // The -P line was printed before the option above was set.
      return { ...parsed, named: Boolean(name) }
    } catch (e: any) {
      if (e?.stderr?.includes('duplicate session') || e?.message?.includes('duplicate session')) {
        attempt++
        continue
      }
      throw e
    }
  }
  throw new Error(`Could not create session: too many name collisions for ${sessionName}`)
}

/**
 * Lines that have scrolled off the top of a session's pane, oldest first,
 * with colour escapes intact. Empty when there is no history yet.
 *
 * Scrollback lives in the browser: tmux runs on the outer terminal's main
 * screen (see ~/.tmux.conf), so xterm.js keeps its own history and the wheel
 * scrolls locally. A freshly attached client therefore has to be handed
 * whatever scrolled off before it arrived. Visible rows are excluded because
 * tmux repaints those itself on attach.
 */
export async function captureHistory(
  sessionId: number,
  exec: TmuxExecutor = defaultExec,
): Promise<string> {
  const target = `$${sessionId}`
  const { stdout: sizeOut } = await exec('tmux', ['display-message', '-p', '-t', target, '#{history_size}'])
  const size = parseInt(sizeOut.trim(), 10)
  if (!size) return ''
  // -e keeps colours, -J re-joins lines tmux wrapped so xterm can wrap them
  // for its own width; -S/-E select history lines only (negative = above
  // the visible screen, -1 = the line just above it).
  const { stdout } = await exec('tmux', [
    'capture-pane', '-p', '-e', '-J', '-t', target, '-S', `-${size}`, '-E', '-1',
  ])
  return stdout
}

/**
 * Kill a Nest session by its tmux session id.
 */
export async function killWindow(
  sessionId: number,
  exec: TmuxExecutor = defaultExec,
): Promise<void> {
  await exec('tmux', ['kill-session', '-t', `$${sessionId}`])
}

/**
 * Rename a Nest session by its tmux session id, and mark it as explicitly
 * named so the UI stops preferring the pane title.
 */
export async function renameWindow(
  sessionId: number,
  name: string,
  exec: TmuxExecutor = defaultExec,
): Promise<void> {
  await exec('tmux', ['rename-session', '-t', `$${sessionId}`, `${PREFIX}${name}`])
  await exec('tmux', ['set', '-t', `$${sessionId}`, NAMED_OPTION, '1'])
}
