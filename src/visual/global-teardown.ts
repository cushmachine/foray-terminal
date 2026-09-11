import { tmuxSocketArgs } from '../server/tmux.ts'
import { tmux } from './helpers.ts'
import { TMUX_SOCKET } from '../../playwright.config.ts'

/**
 * Kill the whole tmux server the suite ran on, not just the sessions whose
 * names it recognises. The suite creates sessions through the UI, and one
 * that is never renamed keeps Foray's default name (foray_bash), which a
 * foray_visual- prefix filter leaves behind to accumulate run after run.
 *
 * Killing the server is only safe because the socket is the suite's own
 * dedicated one (playwright.config.ts's TMUX_SOCKET, a fixed constant that
 * ignores whatever FORAY_TMUX_SOCKET the caller's own shell may already
 * have exported — see the comment there). Checked here against that exact
 * value, not merely "is a -L flag present": tmuxSocketArgs() reads
 * FORAY_TMUX_SOCKET fresh from the environment at call time, so this is
 * the one place standing between a misconfigured environment and a
 * `kill-server` on someone's real Foray socket. Refuse anything but an
 * exact match, including empty (the machine's default socket).
 */
export default function globalTeardown(): void {
  const args = tmuxSocketArgs()
  const expected = ['-L', TMUX_SOCKET]
  if (args.length !== expected.length || args.some((a, i) => a !== expected[i])) {
    throw new Error(
      `visual teardown: expected the suite's own tmux socket (${JSON.stringify(expected)}), got ` +
        `${JSON.stringify(args)} instead. Refusing to kill-server — this might be a live Foray ` +
        'socket. See playwright.config.ts.',
    )
  }
  try {
    tmux(['kill-server'])
  } catch {
    // No server running: nothing to clean up.
  }
}
