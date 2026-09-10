// Shared helper for the e2e suites, which drive a real tmux server rather
// than the in-memory fake the unit suites use. The socket is spelled once
// here instead of once per raw execFileSync/execFile call site.

import { execFile as _execFile, execFileSync } from 'node:child_process'
import { promisify } from 'node:util'
import { tmuxSocketArgs } from '../server/tmux.ts'

const execFileAsync = promisify(_execFile)

/** Run a real tmux command on Foray's own socket (FORAY_TMUX_SOCKET), synchronously. */
export function tmuxSync(args: string[], options: { stdio?: 'pipe' | 'ignore' } = {}): string {
  return execFileSync('tmux', [...tmuxSocketArgs(), ...args], { stdio: ['ignore', options.stdio ?? 'pipe', 'ignore'] }).toString()
}

/** Run a real tmux command on Foray's own socket (FORAY_TMUX_SOCKET), asynchronously. */
export function tmuxAsync(args: string[]): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync('tmux', [...tmuxSocketArgs(), ...args])
}
