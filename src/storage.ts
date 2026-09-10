// localStorage with the keys Foray persists under, in one place.
//
// localStorage throws in some private-browsing and embedded contexts; none
// of what Foray stores is worth crashing over, so a failure reads as absent
// and a write is silently dropped.

/** The session this device last looked at, reopened on the next page load. */
export const LAST_SESSION_KEY = 'nest:lastSession'
export const FONT_SIZE_KEY = 'nest:fontSize'
/** The desktop key-toolbar choice ('true' | 'false'); touch layouts ignore it. */
export const KEY_TOOLBAR_KEY = 'nest:keyToolbar'
/** Whether the sidebar's past-sessions section is open ('true' / 'false'). */
export const PAST_SESSIONS_KEY = 'nest:pastSessions'

/** The Composer's unsent text, one entry per session id. */
export function draftKeyFor(sessionId: number): string {
  return `nest:draft:${sessionId}`
}

export function storageGet(key: string): string | null {
  try {
    return window.localStorage.getItem(key)
  } catch {
    return null
  }
}

export function storageSet(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value)
  } catch {
    // The value just won't persist.
  }
}

export function storageRemove(key: string): void {
  try {
    window.localStorage.removeItem(key)
  } catch {
    // Already as good as gone.
  }
}
