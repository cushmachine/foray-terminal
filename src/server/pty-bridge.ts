// PTY bridge: attaches to a tmux session via node-pty.
//
// Each WebSocket client that views a terminal gets its own pty process
// running `tmux attach-session -t $<windowId>`: every Nest session is its own
// tmux session, and windowId is that session's tmux id.

import * as pty from 'node-pty'

/** Handle returned to callers for I/O and lifecycle management. */
export interface PtyHandle {
  write(data: string): void
  resize(cols: number, rows: number): void
  kill(): void
  /** Stop reading from the pty; the program behind it blocks once its buffer fills. */
  pause(): void
  resume(): void
}

/** Minimal pty process interface: what we actually use from node-pty. */
export interface PtyProcess {
  onData(callback: (data: string) => void): unknown
  onExit(callback: (event: { exitCode: number }) => void): unknown
  write(data: string): void
  resize(cols: number, rows: number): void
  kill(): void
  pause(): void
  resume(): void
}

/** Spawner signature, injectable for testing. */
export type PtySpawner = (
  file: string,
  args: string[],
  options: { name: string; cols: number; rows: number; env: Record<string, string | undefined> },
) => PtyProcess

const defaultSpawn: PtySpawner = (file, args, options) =>
  pty.spawn(file, args, options as pty.IPtyForkOptions)

export interface PtyEvents {
  /** Output from the pane. */
  onData: (data: string) => void
  /** The attach process ended: the session was killed, or tmux went away. */
  onExit: (exitCode: number) => void
}

/**
 * Attach a pty to a Nest session (a tmux session whose id is `windowId`).
 * The pty runs `tmux attach-session -t $<windowId>`.
 */
export function attachToPane(
  windowId: number,
  events: PtyEvents,
  opts?: { cols?: number; rows?: number },
  spawn: PtySpawner = defaultSpawn,
): PtyHandle {
  const proc = spawn(
    'tmux',
    ['attach-session', '-t', `$${windowId}`],
    {
      name: 'xterm-256color',
      cols: opts?.cols ?? 80,
      rows: opts?.rows ?? 24,
      env: process.env as Record<string, string | undefined>,
    },
  )

  proc.onData(events.onData)
  proc.onExit(({ exitCode }) => events.onExit(exitCode))
  return proc
}
