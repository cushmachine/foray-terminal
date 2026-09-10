import { SESSION_PREFIX, tmux } from './helpers.ts'

/** Kill any foray_visual-* tmux session a failed test left behind. */
export default function globalTeardown(): void {
  let names: string[] = []
  try {
    names = tmux(['list-sessions', '-F', '#{session_name}'])
      .split('\n')
      .filter((n) => n.startsWith(`foray_${SESSION_PREFIX}`))
  } catch {
    return // no tmux server: nothing to clean
  }
  for (const name of names) {
    try {
      tmux(['kill-session', '-t', name])
    } catch {
      // already gone
    }
  }
}
