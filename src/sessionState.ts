// Pure session bookkeeping: the session list, which session is active,
// and the flag for a session this client asked for.
//
// Extracted out of App.tsx so it can be unit tested without React or a
// DOM (src/__tests__/socket-and-sessions.test.ts).

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
 * Sessions in creation order. tmux lists sessions by name, so bash-10 would
 * otherwise sort before bash-2; ids are allocated sequentially, so ascending
 * id is creation order. Returns a new array; the input is not mutated.
 */
export function sortSessions(sessions: readonly Session[]): Session[] {
  return [...sessions].sort((a, b) => a.id - b.id)
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

/**
 * The active session after a full list arrives. A still-existing choice is
 * kept. Otherwise (first list of this page load, or the active session is
 * gone) the session this device last looked at, from storage, is reopened
 * if it still exists; failing that, the first listed one.
 */
export function activeAfterList(
  windows: readonly Session[],
  active: number | null,
  savedRaw: string | null,
): number | null {
  if (active !== null && windows.some((w) => w.id === active)) return active
  const saved = savedRaw !== null ? Number(savedRaw) : NaN
  if (Number.isInteger(saved) && windows.some((w) => w.id === saved)) return saved
  return windows[0]?.id ?? null
}

/**
 * The active session after `killedId` is killed. `sessions` is the list
 * before the kill. Killing another session changes nothing. Killing the
 * active one moves to its neighbour in creation order (the next newer, or
 * the newest older one) right away, rather than showing an empty terminal
 * area until the next poll's list arrives.
 */
export function nextActiveAfterKill(
  sessions: readonly Session[],
  active: number | null,
  killedId: number,
): number | null {
  if (active !== killedId) return active
  const ordered = sortSessions(sessions)
  const index = ordered.findIndex((s) => s.id === killedId)
  const survivors = ordered.filter((s) => s.id !== killedId)
  if (survivors.length === 0) return null
  const neighbour = index === -1 ? survivors[0] : survivors[Math.min(index, survivors.length - 1)]
  return neighbour.id
}

/**
 * The "this client asked for a session" flag after `msg`. Set by the create
 * button so that only this device, not every device, switches to the
 * session that arrives. It clears when the session arrives or when the
 * create fails; otherwise the next session anyone else creates would yank
 * this device into it.
 */
export function pendingCreateAfter(pending: boolean, msg: ServerMessage): boolean {
  if (!pending) return false
  if (msg.type === 'session:created') return false
  if (msg.type === 'error') return msg.request !== 'session:create'
  return pending
}

export interface SessionsState {
  sessions: Session[]
  active: number | null
  /** This client asked for a session and is waiting for it; see pendingCreateAfter. */
  pendingCreate: boolean
  /**
   * Counts the times this client picked a session to look at: a tap in the
   * list, or the arrival of one it asked for. A list or a kill moving the
   * active session does not count. App brings the terminal into view when
   * it changes.
   */
  picked: number
}

export const NO_SESSIONS: SessionsState = { sessions: [], active: null, pendingCreate: false, picked: 0 }

export type SessionsAction =
  | { type: 'select'; id: number }
  /** This client asked the server for a session. */
  | { type: 'create' }
  | {
      type: 'message'
      msg: ServerMessage
      /** The stored last-session id, consulted when a list arrives. */
      savedRaw: string | null
    }

/**
 * The list and the active session move together: a kill or a new list
 * that removes the active session must pick a replacement in the same
 * step, so there is never a render pointing at a session that is gone.
 * Every server message goes through here, errors included, so the create
 * flag clears on a failed create. Returns the same state reference when
 * nothing changed.
 */
export function reduceSessions(state: SessionsState, action: SessionsAction): SessionsState {
  if (action.type === 'select') {
    // Picking the session already in view still counts: on a phone that
    // closes the drawer.
    return { ...state, active: action.id, picked: state.picked + 1 }
  }
  if (action.type === 'create') {
    return state.pendingCreate ? state : { ...state, pendingCreate: true }
  }
  const { msg } = action
  const own = state.pendingCreate && msg.type === 'session:created'
  const pendingCreate = pendingCreateAfter(state.pendingCreate, msg)
  const sessions = applySessionMessage(state.sessions, msg)
  let active = state.active
  let picked = state.picked
  switch (msg.type) {
    case 'session:list':
      active = activeAfterList(sessions, state.active, action.savedRaw)
      break
    case 'session:created':
      if (own) {
        active = msg.window.id
        picked++
      }
      break
    case 'session:killed':
      active = nextActiveAfterKill(state.sessions, state.active, msg.windowId)
      break
    default:
      break
  }
  if (
    sessions === state.sessions && active === state.active
    && pendingCreate === state.pendingCreate && picked === state.picked
  ) return state
  return { sessions, active, pendingCreate, picked }
}
