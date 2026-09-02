// Pure session-list reducer.
//
// Applies incoming ServerMessages to the client's session list. Extracted
// out of App.tsx so this bookkeeping can be unit tested without React or a
// DOM — see src/__tests__/chunkC.test.ts.

import type { ServerMessage, TmuxWindow } from './shared/protocol'

/** A Nest session as displayed in the UI. */
export type Session = TmuxWindow

/**
 * Name to show for a session. An explicit Nest name always wins. Otherwise
 * the live terminal title the running program set (Claude Code's /rename,
 * for instance) beats the auto-generated session name.
 */
export function displayName(session: Session): string {
  if (!session.named && session.title) return session.title
  return session.name
}

/**
 * Applies a ServerMessage to a session list, returning a new array.
 * Messages that don't affect the session list return the same array
 * reference, unchanged.
 */
export function applySessionMessage(sessions: Session[], msg: ServerMessage): Session[] {
  switch (msg.type) {
    case 'session:list':
      return msg.windows
    case 'session:created':
      if (sessions.some((s) => s.id === msg.window.id)) return sessions
      return [...sessions, msg.window]
    case 'session:killed':
      return sessions.filter((s) => s.id !== msg.windowId)
    case 'session:renamed':
      return sessions.map((s) =>
        s.id === msg.windowId ? { ...s, name: msg.name, named: true } : s,
      )
    default:
      return sessions
  }
}

/**
 * Sessions whose terminal has been mounted. Terminals are created the first
 * time a session is viewed rather than for every session on load: an xterm
 * instance plus a server pty per session is heavy on a phone, and each
 * attach takes ownership away from whoever else is looking at that
 * session. Once opened a terminal stays mounted so its scrollback survives
 * switching away and back.
 */
export function openedWith(opened: readonly number[], id: number | null): number[] {
  if (id === null || opened.includes(id)) return opened as number[]
  return [...opened, id]
}
