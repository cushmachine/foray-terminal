// The contract between Foray and a coding agent whose sessions it can list
// and revive. Foray itself knows nothing about any agent's files or CLI:
// everything agent-specific lives behind this interface, one file per
// agent under src/server/agents/. Adding an agent means adding a provider
// and registering it in index.ts; the protocol, client and tests stay put.

/** One past session, as the provider found it on disk. */
export interface AgentSession {
  /** The agent's own id for the session; what its resume command takes. */
  id: string
  /** Short human title: the agent's summary when it keeps one, else the opening prompt. */
  title: string
  /** The most recent thing the user asked, or '' when unknown. */
  lastPrompt: string
  /** Working directory the session ran in. */
  cwd: string
  /** Git branch at the time, or '' when unknown. */
  branch: string
  /** Last activity, ms since the epoch. */
  lastActive: number
}

/** A session the agent is running right now. */
export interface LiveSession {
  id: string
  /** tmux session it runs in, as tmux names it (prefix included), when the agent records that. */
  tmuxSession?: string
  /**
   * tmux window id ("@6") it runs in, when recorded. Preferred over the
   * session name: names change as titles change, ids never do.
   */
  tmuxWindow?: string
}

export interface AgentProvider {
  /** Stable machine id, lowercase, used on the wire and in env var names ("claude"). */
  id: string
  /** What the sidebar shows when more than one agent is configured ("Claude Code"). */
  label: string
  /**
   * Whether `id` has the shape of one of this agent's session ids. Only an
   * id that passes reaches the resume command, so this is the whole
   * defence against a crafted id; keep it strict.
   */
  isSessionId(id: string): boolean
  /** Every past session on disk, in any order. Cheap when nothing changed. */
  scan(): Promise<AgentSession[]>
  /** Sessions running at this moment. */
  live(): Promise<LiveSession[]>
  /** The argv that resumes session `id` in an interactive shell. */
  resumeCommand(id: string): string[]
}
