// The environment Foray hands to what it spawns.
//
// A shell in a session runs as the same user and could read the token
// file anyway, but a program printing `env` to a log or a transcript
// should not carry the token into it. tmux keeps the environment of
// whoever started its server as the global environment of every later
// session, so the scrub applies to every tmux invocation, not only the
// pty that attaches.

/** `env` without Foray's own variables. */
export function sessionEnv(env: NodeJS.ProcessEnv): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {}
  for (const [key, value] of Object.entries(env)) {
    if (key.startsWith('FORAY_')) continue
    out[key] = value
  }
  return out
}
