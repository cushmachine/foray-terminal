// Tmux CLI wrapper for Foray.
//
// Each Foray "session" is its own tmux session (not a window within one
// session). This avoids shared views and size-mismatch artifacts when
// multiple terminals are open. Sessions are named with a "foray_" prefix;
// a session named "nest_" by a pre-rename Foray is still read as one of
// ours, for one release (PREFIX_RE).

import { execFile as _execFile } from 'node:child_process'
import os from 'node:os'
import { promisify } from 'node:util'
import type { TmuxWindow } from '../shared/protocol.ts'
import { ClientError } from './errors.ts'
import { sessionEnv } from './env.ts'
import type { PaneHistoryState } from './history.ts'

const promisedExecFile = promisify(_execFile)

/** Signature for the tmux command executor, injectable for testing. */
export type TmuxExecutor = (
  cmd: string,
  args: string[],
) => Promise<{ stdout: string; stderr: string }>

/** Foray's own tmux socket name; see tmuxSocketArgs for what unset/'' mean. */
const DEFAULT_SOCKET = 'foray'

/**
 * The `-L` argv prefix every tmux invocation needs to land on Foray's own
 * socket instead of adopting a stranger's tmux server: unset
 * FORAY_TMUX_SOCKET means the dedicated "foray" socket, '' means the
 * machine's default socket (what the owner's box ships with, until every
 * live session has moved over). Exported so the contract itself is
 * testable directly, not only through defaultExec's use of it. Read fresh
 * on every call, not cached, so a test that flips the env var takes effect
 * immediately.
 */
export function tmuxSocketArgs(): string[] {
  const socket = process.env.FORAY_TMUX_SOCKET ?? DEFAULT_SOCKET
  return socket === '' ? [] : ['-L', socket]
}

// Scrubbed env: the first tmux call starts the tmux server, whose
// environment every session inherits (env.ts). The socket flag goes first;
// tmux only recognises -L before the subcommand.
const defaultExec: TmuxExecutor = (cmd, args) =>
  promisedExecFile(cmd, [...tmuxSocketArgs(), ...args], { env: sessionEnv(process.env) })

/** Session names Foray writes today. */
const PREFIX = 'foray_'

/** Matches either prefix; used to recognise a session as ours when reading. */
const PREFIX_RE = /^(?:nest|foray)_/

/**
 * Session user option stamped once the user has explicitly named a session
 * (at create or rename). Lets the UI prefer that name over whatever title
 * the running program sets. Lives in tmux, so it survives Foray restarts.
 * Only ever written as NAMED_OPTION; LEGACY_NAMED_OPTION is read as a
 * fallback for one release, for a stamp a pre-rename Foray wrote.
 */
const NAMED_OPTION = '@foray_named'
const LEGACY_NAMED_OPTION = '@nest_named'

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
  // Prefer the current stamp; fall back to the one a pre-rename Foray wrote.
  `#{?#{${NAMED_OPTION}},#{${NAMED_OPTION}},#{${LEGACY_NAMED_OPTION}}}`,
].join(SEP)

/**
 * Foreground commands under which a pane title carries no information: a
 * program's title outlives the program (tmux never resets it), so once a
 * bare shell is back in front the title is just stale.
 */
const SHELLS = new Set(['bash', 'zsh', 'sh', 'fish', 'dash'])

/**
 * The tmux session name for a user-facing session name. tmux rejects '.'
 * and ':' (they are target syntax), so both become '-'; surrounding
 * whitespace is dropped, and a name with nothing left is refused. Create
 * and rename go through here so the same input always lands on the same
 * name.
 */
export function sessionNameFor(name: string): string {
  const safe = name.trim().replace(/[.:]/g, '-')
  if (!safe) throw new ClientError('Invalid session name')
  return `${PREFIX}${safe}`
}

/** The user-facing name of a Foray session from its tmux session name (either prefix); undefined when it is not one. */
export function forayNameOf(tmuxSession: string): string | undefined {
  const match = PREFIX_RE.exec(tmuxSession)
  return match ? tmuxSession.slice(match[0].length) : undefined
}

/** Longest session name made from a title. */
const SLUG_CHARS = 24

/**
 * A short tmux-safe name from a free-text title: lowercase, runs of
 * anything but [a-z0-9_-] collapsed to one '-' (so a program's status
 * glyph in front of its title goes too), cut to SLUG_CHARS at a word
 * boundary. `fallback` when nothing is left.
 */
export function slugName(title: string, fallback: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
  if (slug.length <= SLUG_CHARS) return slug || fallback
  const cut = slug.slice(0, SLUG_CHARS)
  // Drop the word the cut landed in, unless it is the only one.
  const atWord = cut.lastIndexOf('-')
  return (atWord > 0 ? cut.slice(0, atWord) : cut).replace(/-+$/, '') || fallback
}

/** How many `-N` suffixes to try when a mirrored name is taken. */
const MIRROR_ATTEMPTS = 10

/**
 * Give every session the user has not named a tmux name that mirrors the
 * title its program set (Claude Code's own title or its /rename, say), so
 * `tmux ls`, the agent's own records and the sidebar all call a session
 * the same thing. Called on each listing; a session whose name already
 * matches costs nothing, and one without a meaningful title keeps the
 * name it has (its last title, or the default). A taken name gets a `-N`
 * suffix. Rename failures are left for the next listing to retry.
 * Returns the list with the new names in place.
 */
export async function mirrorTitles(
  windows: TmuxWindow[],
  exec: TmuxExecutor = defaultExec,
): Promise<TmuxWindow[]> {
  const out: TmuxWindow[] = []
  for (const w of windows) {
    if (w.named || !w.title) {
      out.push(w)
      continue
    }
    const wanted = slugName(w.title, '')
    // Already the slug, or the slug with the suffix a collision gave it.
    if (!wanted || w.name === wanted || /^-\d+$/.test(w.name.slice(wanted.length)) && w.name.startsWith(`${wanted}-`)) {
      out.push(w)
      continue
    }
    let renamedTo: string | undefined
    for (let attempt = 0; attempt < MIRROR_ATTEMPTS; attempt++) {
      const candidate = attempt === 0 ? wanted : `${wanted}-${attempt}`
      if (candidate === w.name) break
      try {
        await exec('tmux', ['rename-session', '-t', `$${w.id}`, `${PREFIX}${candidate}`])
        renamedTo = candidate
        break
      } catch (err) {
        if (isDuplicate(err)) continue
        break
      }
    }
    out.push(renamedTo === undefined ? w : { ...w, name: renamedTo })
  }
  return out
}

/**
 * Every tmux window on the server, by window id ("@6"), to the name of
 * the session holding it. Window ids never change, session names do
 * (see mirrorTitles), so a record that names a session by its window id
 * can still be resolved after a rename. Empty when tmux is not running.
 */
export async function listWindowSessions(exec: TmuxExecutor = defaultExec): Promise<Map<string, string>> {
  let stdout: string
  try {
    ;({ stdout } = await exec('tmux', ['list-windows', '-a', '-F', `#{window_id}${SEP}#{session_name}`]))
  } catch (err) {
    if (isNoServer(err)) return new Map()
    throw err
  }
  const map = new Map<string, string>()
  for (const line of stdout.trim().split('\n')) {
    const [windowId, session] = line.split(SEP)
    if (windowId && session) map.set(windowId, session)
  }
  return map
}

/** Whether a tmux failure's stderr or message mentions `text`. */
function failureMentions(err: unknown, text: string): boolean {
  const e = err as { stderr?: string; message?: string } | null
  return Boolean(e?.stderr?.includes(text) || e?.message?.includes(text))
}

/** True when tmux failed because its server is not running (no sessions at all). */
const isNoServer = (err: unknown): boolean => failureMentions(err, 'no server running')

/** True when tmux failed because the target session is gone (or the whole server with it). */
const isMissingTarget = (err: unknown): boolean => failureMentions(err, "can't find") || isNoServer(err)

const isDuplicate = (err: unknown): boolean => failureMentions(err, 'duplicate session')

/**
 * Parse one FORMAT line, e.g. `$5<SEP>foray_shell<SEP>/root<SEP>foray<SEP>bash<SEP>`.
 * Returns sessions with either the current "foray_" prefix or the legacy
 * "nest_" one, so a session from before the rename stays visible.
 *
 * `hostname` is what tmux initialises every pane title to; such a title is
 * reported as empty so the UI falls back to the session name.
 */
function parseLine(line: string, hostname: string): TmuxWindow | null {
  const [rawId, rawName, cwd, rawTitle = '', command = '', named = ''] = line.split(SEP)
  const idMatch = rawId?.match(/^\$(\d+)$/)
  if (!idMatch || !rawName || cwd === undefined) return null
  const name = forayNameOf(rawName)
  if (name === undefined) return null

  const titleIsMeaningful = rawTitle !== '' && rawTitle !== hostname && !SHELLS.has(command)
  return {
    id: parseInt(idMatch[1], 10),
    name,
    cwd,
    title: titleIsMeaningful ? rawTitle : '',
    command,
    named: named === '1',
  }
}

/**
 * List all Foray sessions (tmux sessions with a "foray_" or legacy "nest_" prefix).
 * Returns [] when no Foray sessions exist or the tmux server is not
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
  return stdout
    .trim()
    .split('\n')
    .map((line) => parseLine(line, hostname))
    .filter((w): w is TmuxWindow => w !== null)
}

/**
 * Create a new Foray session. Each session is its own tmux session with
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
    // Always pass a start directory. Without -c, tmux uses the cwd of the
    // process that ran the command, i.e. the Foray server itself (the Foray
    // repo under PM2), which is never where a new session should start.
    const args = [
      'new-session', '-d',
      '-s', actualName,
      '-P', '-F', FORMAT,
      '-c', cwd || os.homedir(),
    ]

    try {
      const { stdout } = await exec('tmux', args)

      // Hide the tmux status bar so it doesn't render inside xterm.js.
      await exec('tmux', ['set', '-t', actualName, 'status', 'off']).catch(() => {})
      if (name) {
        await exec('tmux', ['set', '-t', actualName, NAMED_OPTION, '1']).catch(() => {})
      }
      // The server is up now, whether or not a listing has shown it yet; a
      // server that started with this session has none of the options.
      await applyTmuxServerOptions(exec)

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

/** mouse/history-limit values scripts/foray.tmux.conf ships; re-asserted here as the belt (see the doc below). */
const MOUSE = 'off'
const HISTORY_LIMIT = '10000'

/** The value of a global tmux option, or undefined when it can't be read (no server, an old tmux, ...). */
async function serverOption(exec: TmuxExecutor, option: string): Promise<string | undefined> {
  try {
    const { stdout } = await exec('tmux', ['show', '-g', '-v', option])
    return stdout.trim()
  } catch {
    return undefined
  }
}

/**
 * Let modified keys reach the pane as CSI u, and make sure mouse reporting
 * and the scrollback length are what Foray needs. Foray's client sends
 * Shift+Enter as ESC[13;2u; with tmux's default `extended-keys off` the
 * server parses that as Shift+Enter and hands the pane a bare carriage
 * return, so Claude Code inside submits instead of inserting a newline.
 *
 * `mouse` and `history-limit` normally come from scripts/foray.tmux.conf,
 * but tmux only reads `-f` when it *starts* a server; on macOS, where
 * nothing else starts one, a lost race with the first `new-session` can
 * leave a server running without them, with nothing to notice: short
 * scrollback, mouse reporting left on. So those two are read back and only
 * written when they differ, rather than fighting a session that toggled
 * mouse on for a copy-paste.
 *
 * These are server options (global to the tmux server) and idempotent.
 * Returns false when tmux did not take the extended-keys settings, most
 * often because its server was not running: the caller tries again once
 * it is.
 */
export async function applyTmuxServerOptions(exec: TmuxExecutor = defaultExec): Promise<boolean> {
  try {
    await exec('tmux', ['set', '-s', 'extended-keys', 'always'])
    await exec('tmux', ['set', '-s', 'extended-keys-format', 'csi-u'])
    if ((await serverOption(exec, 'mouse')) !== MOUSE) {
      await exec('tmux', ['set', '-g', 'mouse', MOUSE])
    }
    if ((await serverOption(exec, 'history-limit')) !== HISTORY_LIMIT) {
      await exec('tmux', ['set', '-g', 'history-limit', HISTORY_LIMIT])
    }
    return true
  } catch {
    return false
  }
}

/**
 * Where a session's pane history stands: how many lines it holds, where it
 * stops growing, and whether a full-screen app has frozen it. See
 * history.ts for how the server turns this into scrollback for the client.
 * Throws a ClientError when the session no longer exists.
 */
export async function paneHistoryState(
  sessionId: number,
  exec: TmuxExecutor = defaultExec,
): Promise<PaneHistoryState> {
  let stdout: string
  try {
    ;({ stdout } = await exec('tmux', [
      'display-message', '-p', '-t', `$${sessionId}`, '-F', '#{history_size} #{history_limit} #{alternate_on}',
    ]))
  } catch (err) {
    // Killed since it was listed, by another client or from inside tmux.
    if (isMissingTarget(err)) throw new ClientError('Session not found')
    throw err
  }
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
 * Kill a Foray session by its tmux session id.
 */
export async function killWindow(
  sessionId: number,
  exec: TmuxExecutor = defaultExec,
): Promise<void> {
  await exec('tmux', ['kill-session', '-t', `$${sessionId}`])
}

/**
 * Drop the "user named this" stamp so the session's name mirrors its
 * program's title again (mirrorTitles). For sessions created with a
 * name Foray chose, not the user.
 */
export async function unmarkNamed(sessionId: number, exec: TmuxExecutor = defaultExec): Promise<void> {
  await exec('tmux', ['set', '-u', '-t', `$${sessionId}`, NAMED_OPTION])
  // A session named before the rename carries the old stamp, and FORMAT
  // falls back to it, so clearing only the new one would leave the session
  // still reading as named. Unsetting an absent option is not an error.
  await exec('tmux', ['set', '-u', '-t', `$${sessionId}`, LEGACY_NAMED_OPTION])
}

/**
 * Type a command line into a Foray session's shell and press Enter, as the
 * user would. The command runs under the interactive shell (its rc file
 * loaded) and the shell outlives it. Callers quote the command; tmux
 * passes it through as keystrokes.
 */
export async function runInWindow(
  sessionId: number,
  command: string,
  exec: TmuxExecutor = defaultExec,
): Promise<void> {
  await exec('tmux', ['send-keys', '-t', `$${sessionId}`, command, 'Enter'])
}

/**
 * Rename a Foray session by its tmux session id, and mark it as explicitly
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
