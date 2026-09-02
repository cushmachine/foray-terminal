// PTY bridge: attaches to a tmux pane via node-pty.
//
// Each WebSocket client that views a terminal gets its own pty process
// running `tmux attach-session -t nest:@{windowId}`.

import * as pty from 'node-pty'

/** Handle returned to callers for I/O and lifecycle management. */
export interface PtyHandle {
  write(data: string): void
  resize(cols: number, rows: number): void
  kill(): void
}

/** Minimal pty process interface — what we actually use from node-pty. */
export interface PtyProcess {
  onData(callback: (data: string) => void): unknown
  write(data: string): void
  resize(cols: number, rows: number): void
  kill(): void
}

/** Spawner signature, injectable for testing. */
export type PtySpawner = (
  file: string,
  args: string[],
  options: { name: string; cols: number; rows: number; env: Record<string, string | undefined> },
) => PtyProcess

const defaultSpawn: PtySpawner = (file, args, options) =>
  pty.spawn(file, args, options as pty.IPtyForkOptions)

/**
 * Attach a pty to a specific tmux window in the "nest" session.
 * The pty runs `tmux attach-session -t nest:@{windowId}`.
 * Data from the pty is forwarded through the onData callback.
 */
export function attachToPane(
  windowId: number,
  onData: (data: string) => void,
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

  proc.onData(onData)

  return {
    write: (data) => proc.write(data),
    resize: (cols, rows) => proc.resize(cols, rows),
    kill: () => proc.kill(),
  }
}
