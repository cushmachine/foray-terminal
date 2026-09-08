// localStorage with the keys Nest persists under, in one place.
//
// localStorage throws in some private-browsing and embedded contexts; none
// of what Nest stores is worth crashing over, so a failure reads as absent
// and a write is silently dropped.

/** The session this device last looked at, reopened on the next page load. */
export const LAST_SESSION_KEY = 'nest:lastSession'
/** Prefix for the Composer's unsent text, one entry per session id. */
export const DRAFT_KEY_PREFIX = 'nest:draft:'
export const FONT_SIZE_KEY = 'nest:fontSize'
/** The desktop key-toolbar choice ('true' | 'false'); touch layouts ignore it. */
export const KEY_TOOLBAR_KEY = 'nest:keyToolbar'

export function draftKeyFor(sessionId: number): string {
  return `${DRAFT_KEY_PREFIX}${sessionId}`
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
