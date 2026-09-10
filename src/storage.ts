// localStorage with the keys Foray persists under, in one place.
//
// localStorage throws in some private-browsing and embedded contexts; none
// of what Foray stores is worth crashing over, so a failure reads as absent
// and a write is silently dropped.
//
// Keys moved from a "nest:" prefix to "foray:" with the rename. storageGet
// falls back to the old key once, for every "foray:" key alike, and
// rewrites the value under the new key so the fallback is never needed
// again for that key.

const PREFIX = 'foray:'
const LEGACY_PREFIX = 'nest:'

/** The session this device last looked at, reopened on the next page load. */
export const LAST_SESSION_KEY = `${PREFIX}lastSession`
export const FONT_SIZE_KEY = `${PREFIX}fontSize`
/** The desktop key-toolbar choice ('true' | 'false'); touch layouts ignore it. */
export const KEY_TOOLBAR_KEY = `${PREFIX}keyToolbar`
/** Whether the sidebar's past-sessions section is open ('true' / 'false'). */
export const PAST_SESSIONS_KEY = `${PREFIX}pastSessions`

/** The Composer's unsent text, one entry per session id. */
export function draftKeyFor(sessionId: number): string {
  return `${PREFIX}draft:${sessionId}`
}

export function storageGet(key: string): string | null {
  try {
    const value = window.localStorage.getItem(key)
    if (value !== null || !key.startsWith(PREFIX)) return value
    const legacy = window.localStorage.getItem(LEGACY_PREFIX + key.slice(PREFIX.length))
    if (legacy === null) return null
    // Rewrite once: every later read lands on the fast path above, so a
    // stale write to the legacy key later (some old tab, say) can never
    // resurrect after this one has migrated.
    storageSet(key, legacy)
    return legacy
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
