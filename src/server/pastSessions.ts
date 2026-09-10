// Past sessions across every configured agent, and how one is revived.
//
// Revival is a Foray session (tmux new-session in the transcript's cwd)
// plus the agent's resume command typed into the shell that starts there
// (tmux send-keys). Typing it, rather than making it the session's
// command, means the user's shell rc is loaded (PATH from nvm, their own
// env) and the shell, and so the Foray session, survives when the agent
// exits. Only an id the provider vouches for is ever typed, and every
// argv element is quoted, so nothing the client sent reaches the shell
// as syntax.

import fs from 'node:fs/promises'
import os from 'node:os'
import type { PastSession } from '../shared/protocol.ts'
import type { AgentProvider } from './agents/types.ts'
import { ClientError } from './errors.ts'
import { listWindowSessions, nestNameOf, slugName, type TmuxExecutor } from './tmux.ts'

/** A POSIX shell command line from argv: every element single-quoted. */
export function shellQuote(argv: string[]): string {
  return argv.map((arg) => `'${arg.replace(/'/g, `'\\''`)}'`).join(' ')
}

/** Where a live session runs, per its agent's record, before the window id is resolved. */
interface LiveAt {
  session?: string
  window?: string
}

/** What a revive needs: where to start the Foray session, what to call it, what to type. */
export interface Revival {
  name: string
  cwd: string
  command: string
}

export interface PastSessionsOptions {
  /** Where a session starts when its directory is gone. Defaults to the home dir. */
  homeDir?: string
  /** How tmux is invoked, for resolving which Foray session a live one is in. */
  tmuxExec?: TmuxExecutor
}

export class PastSessions {
  private readonly homeDir: string
  private readonly tmuxExec: TmuxExecutor | undefined

  constructor(
    private readonly providers: AgentProvider[],
    options: PastSessionsOptions = {},
  ) {
    this.homeDir = options.homeDir ?? os.homedir()
    this.tmuxExec = options.tmuxExec
  }

  /** Whether the sidebar should show which agent each row belongs to. */
  get multiple(): boolean {
    return this.providers.length > 1
  }

  /** Every provider's sessions, live ones marked, newest first. */
  async list(): Promise<PastSession[]> {
    const [windows, ...perProvider] = await Promise.all([
      listWindowSessions(this.tmuxExec).catch(() => new Map<string, string>()),
      ...this.providers.map((p) => this.listFor(p)),
    ])
    const rows = perProvider.flat().map(({ row, at }) => {
      // The agent recorded its tmux session by name as of its start; the
      // window id is what still holds after the session was renamed.
      const session = at === undefined ? undefined : windows.get(at.window ?? '') ?? at.session
      const liveIn = session === undefined ? undefined : nestNameOf(session)
      return liveIn === undefined ? row : { ...row, liveIn }
    })
    return rows.sort((a, b) => b.lastActive - a.lastActive)
  }

  private async listFor(provider: AgentProvider): Promise<Array<{ row: PastSession; at?: LiveAt }>> {
    const [sessions, live] = await Promise.all([provider.scan(), provider.live()])
    const liveById = new Map(live.map((l) => [l.id, l]))
    return sessions.map((s) => {
      const running = liveById.get(s.id)
      const row: PastSession = {
        agent: provider.id,
        agentLabel: provider.label,
        id: s.id,
        title: s.title,
        lastPrompt: s.lastPrompt,
        cwd: s.cwd,
        branch: s.branch,
        lastActive: s.lastActive,
        live: running !== undefined,
      }
      const at = running && (running.tmuxSession || running.tmuxWindow)
        ? { session: running.tmuxSession, window: running.tmuxWindow }
        : undefined
      return { row, at }
    })
  }

  /**
   * Resolve a revive request. Throws a ClientError for an unknown agent,
   * an id the provider does not recognise, a session that is not on disk,
   * or one that is running now (resuming it would fork the conversation).
   */
  async resolve(agent: string, id: string): Promise<Revival> {
    const provider = this.providers.find((p) => p.id === agent)
    if (!provider) throw new ClientError(`Unknown agent: ${agent}`)
    if (!provider.isSessionId(id)) throw new ClientError('Invalid session id')
    const session = (await provider.scan()).find((s) => s.id === id)
    if (!session) throw new ClientError('Session not found')
    if ((await provider.live()).some((l) => l.id === id)) throw new ClientError('Session is already running')
    // A project that was moved or deleted since: start at home rather than fail.
    const cwd = (await fs.access(session.cwd).then(() => true, () => false)) ? session.cwd : this.homeDir
    return {
      name: slugName(session.title, provider.id),
      cwd,
      command: shellQuote(provider.resumeCommand(id)),
    }
  }
}
