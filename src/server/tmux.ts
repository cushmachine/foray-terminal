// Tmux CLI wrapper for Nest.
//
// Each Nest "session" is its own tmux session (not a window within one
// session). This avoids shared views and size-mismatch artifacts when
// multiple terminals are open. Sessions are named with a "nest_" prefix.

import { execFile as _execFile } from 'node:child_process'
import os from 'node:os'
import { promisify } from 'node:util'
import type { TmuxWindow } from '../shared/protocol.ts'
import { ClientError } from './errors.ts'
import type { PaneHistoryState } from './history.ts'

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
 * The tmux session name for a user-facing session name. tmux rejects '.'
 * and ':' (they are target syntax), so both become '-'. Create and rename
 * go through here so the same input always lands on the same name.
 */
export function sessionNameFor(name: string): string {
  const safe = name.replace(/[.:]/g, '-')
  if (!safe) throw new ClientError('Invalid session name')
  return `${PREFIX}${safe}`
}

/** Whether a tmux failure's stderr or message mentions `text`. */
function failureMentions(err: unknown, text: string): boolean {
  const e = err as { stderr?: string; message?: string } | null
  return Boolean(e?.stderr?.includes(text) || e?.message?.includes(text))
}

/** True when tmux failed because its server is not running (no sessions at all). */
const isNoServer = (err: unknown): boolean => failureMentions(err, 'no server running')

const isDuplicate = (err: unknown): boolean => failureMentions(err, 'duplicate session')

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
 * Returns [] when no Nest sessions exist or the tmux server is not
 * running; any other tmux failure is thrown, so a caller can tell "no
 * sessions" from "tmux is broken" and keep its last good list.
 */
export async function listWindows(
  exec: TmuxExecutor = defaultExec,
  hostname: string = os.hostname(),
): Promise<TmuxWindow[]> {
  let stdout: string
  try {
    ;({ stdout } = await exec('tmux', ['list-sessions', '-F', FORMAT]))
  } catch (err) {
    if (isNoServer(err)) return []
    throw err
  }
  if (!stdout.trim()) return []
  return stdout
    .trim()
    .split('\n')
    .map((line) => parseLine(line, hostname))
    .filter((w): w is TmuxWindow => w !== null)
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
  const sessionName = sessionNameFor(name || 'bash')

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
    } catch (err) {
      if (isDuplicate(err)) {
        attempt++
        continue
      }
      throw err
    }
  }
  throw new ClientError(`Could not create session: too many name collisions for ${sessionName}`)
}

/**
 * Let modified keys reach the pane as CSI u. Nest's client sends Shift+Enter
 * as ESC[13;2u; with tmux's default `extended-keys off` the server parses
 * that as Shift+Enter and hands the pane a bare carriage return, so Claude
 * Code inside submits instead of inserting a newline. These are server
 * options (global to the tmux server) and idempotent; a tmux too old to
 * know them just keeps its defaults. Returns false when the tmux server
 * was not running to take them: the caller tries again once it is.
 */
export async function enableExtendedKeys(exec: TmuxExecutor = defaultExec): Promise<boolean> {
  try {
    await exec('tmux', ['set', '-s', 'extended-keys', 'always'])
    await exec('tmux', ['set', '-s', 'extended-keys-format', 'csi-u'])
    return true
  } catch (err) {
    return !isNoServer(err)
  }
}

/**
 * Where a session's pane history stands: how many lines it holds, where it
 * stops growing, and whether a full-screen app has frozen it. See
 * history.ts for how the server turns this into scrollback for the client.
 */
export async function paneHistoryState(
  sessionId: number,
  exec: TmuxExecutor = defaultExec,
): Promise<PaneHistoryState> {
  const { stdout } = await exec('tmux', [
    'display-message', '-p', '-t', `$${sessionId}`, '-F', '#{history_size} #{history_limit} #{alternate_on}',
  ])
  const [size = '0', limit = '0', alternate = '0'] = stdout.trim().split(/\s+/)
  return {
    size: parseInt(size, 10) || 0,
    limit: parseInt(limit, 10) || 0,
    alternate: alternate === '1',
  }
}

/**
 * The last `count` rows of a session's pane history as logical lines,
 * oldest first, with colour escapes intact. `-J` joins the rows tmux
 * soft-wrapped at its width back into the line the program wrote, so the
 * client wraps it once, at its own width, instead of a second time on top
 * of tmux's break. A line that continues onto the visible screen comes
 * back as its history part only (tmux still ends it with a newline) and
 * grows in later captures; history.ts allows for that. Returns [] for
 * count 0; capture-pane would hand back the top visible row instead.
 */
export async function captureHistoryLines(
  sessionId: number,
  count: number,
  exec: TmuxExecutor = defaultExec,
): Promise<string[]> {
  if (count <= 0) return []
  // -S/-E select history rows only: negative rows sit above the visible
  // screen, and -1 is the row just above it.
  const { stdout } = await exec('tmux', [
    'capture-pane', '-p', '-e', '-J', '-t', `$${sessionId}`, '-S', `-${count}`, '-E', '-1',
  ])
  const lines = stdout.split('\n')
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return lines
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
  await exec('tmux', ['rename-session', '-t', `$${sessionId}`, sessionNameFor(name)])
  await exec('tmux', ['set', '-t', `$${sessionId}`, NAMED_OPTION, '1'])
}
