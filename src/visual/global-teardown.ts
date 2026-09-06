import { execFileSync } from 'node:child_process'
import { SESSION_PREFIX } from './helpers.ts'

/** Kill any nest_visual-* tmux session a failed test left behind. */
export default function globalTeardown(): void {
  let names: string[] = []
  try {
    names = execFileSync('tmux', ['list-sessions', '-F', '#{session_name}'], { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .split('\n')
      .filter((n) => n.startsWith(`nest_${SESSION_PREFIX}`))
  } catch {
    return // no tmux server: nothing to clean
  }
  for (const name of names) {
    try {
      execFileSync('tmux', ['kill-session', '-t', name], { stdio: 'ignore' })
    } catch {
      // already gone
    }
  }
}
