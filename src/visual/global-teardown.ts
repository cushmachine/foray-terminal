import { tmuxSocketArgs } from '../server/tmux.ts'
import { tmux } from './helpers.ts'

/**
 * Kill the whole tmux server the suite ran on, not just the sessions whose
 * names it recognises. The suite creates sessions through the UI, and one
 * that is never renamed keeps Foray's default name (foray_bash), which a
 * foray_visual- prefix filter leaves behind to accumulate run after run.
 *
 * Killing the server is only safe because the socket is the suite's own
 * (playwright.config.ts pins FORAY_TMUX_SOCKET to foray-test). If that
 * pin ever goes missing, tmuxSocketArgs() is empty and the server on the
 * other end is the machine's default one — someone's real sessions — so
 * refuse rather than clean up.
 */
export default function globalTeardown(): void {
  if (tmuxSocketArgs().length === 0) {
    throw new Error(
      'visual teardown: FORAY_TMUX_SOCKET is empty, so this would kill the machine\'s ' +
        'default tmux server and every session in it. Refusing; see playwright.config.ts.',
    )
  }
  try {
    tmux(['kill-server'])
  } catch {
    // No server running: nothing to clean up.
  }
}
