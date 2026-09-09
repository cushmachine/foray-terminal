// Pure helpers for the sidebar's "Past sessions" section, kept out of
// Sidebar.tsx so they can be unit-tested without a DOM.

import type { PastSession } from './shared/protocol'

/** Rows shown before the list offers "show N more". */
export const PAST_LIMIT = 15

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const WEEK = 7 * DAY
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** "just now", "5m", "3h", "2d", "3w", then a date ("Aug 14"). */
export function relativeTime(ms: number, now: number): string {
  const diff = Math.max(0, now - ms)
  if (diff < MINUTE) return 'just now'
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)}m`
  if (diff < DAY) return `${Math.floor(diff / HOUR)}h`
  if (diff < WEEK) return `${Math.floor(diff / DAY)}d`
  if (diff < 5 * WEEK) return `${Math.floor(diff / WEEK)}w`
  const date = new Date(ms)
  return `${MONTHS[date.getMonth()]} ${date.getDate()}`
}

/** The rows to render and how many are held back behind "show more". */
export function visiblePast<T>(list: readonly T[], expanded: boolean, limit = PAST_LIMIT): { shown: T[]; hidden: number } {
  if (expanded || list.length <= limit) return { shown: [...list], hidden: 0 }
  return { shown: list.slice(0, limit), hidden: list.length - limit }
}

/** Whether rows need an agent label: only when more than one agent is present. */
export function showsAgent(list: readonly PastSession[]): boolean {
  return new Set(list.map((s) => s.agent)).size > 1
}
