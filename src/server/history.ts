// Scrollback for the browser comes from tmux's own history.
//
// tmux tells an attached terminal only what it needs to repaint the screen.
// When more than a screenful arrives at once it paints the end and skips
// the middle, so a browser that builds scrollback from the byte stream ends
// up with holes. tmux's history buffer has every line, so the server reads
// it from there and ships lines to the client as they land. These are the
// pure decisions; the tmux calls and the per-connection state live in
// tmux.ts and index.ts.

export interface PaneHistoryState {
  /** Lines currently in the pane's history (above the visible screen). */
  size: number
  /** history-limit for the pane: history stops growing here and rotates. */
  limit: number
  /** True while a full-screen app has the alternate screen; history is frozen. */
  alternate: boolean
}

export type HistoryPlan =
  /** Nothing to do. */
  | { kind: 'none' }
  /** Capture the last `count` lines and align them against what was already sent. */
  | { kind: 'sync'; count: number }
  /** Capture everything; the client replaces its copy. */
  | { kind: 'reset' }

/**
 * Lines to fetch when history is at its limit. New lines are found by
 * overlap with the last lines sent, so this only has to cover what could
 * have arrived since the previous check.
 */
export const SATURATED_WINDOW = 200

/**
 * What to fetch given the history size the client is known to have
 * (`known`, null when nothing has been sent yet) and the pane's state now.
 */
export function planHistoryUpdate(
  known: number | null,
  state: PaneHistoryState,
  saturatedWindow: number = SATURATED_WINDOW,
): HistoryPlan {
  if (state.alternate) return { kind: 'none' }
  if (known === null) return { kind: 'reset' }
  // Shrunk: tmux reflowed on a resize, or the history was cleared.
  if (state.size < known) return { kind: 'reset' }
  // At the limit the size no longer moves while lines rotate through, so
  // check a window of the tail every time.
  if (state.limit > 0 && state.size >= state.limit) {
    return { kind: 'sync', count: Math.min(saturatedWindow, state.size) }
  }
  if (state.size === known) return { kind: 'none' }
  return { kind: 'sync', count: state.size - known }
}

/**
 * The lines in `captured` (a fresh tail of the history) that come after
 * the last lines already sent. Matches the longest run of `sentTail`'s end
 * found in `captured`, searching from the newest end. Returns null when
 * they don't overlap at all, meaning the client is too far behind to
 * append and must reset.
 */
export function alignHistory(
  sentTail: readonly string[],
  captured: readonly string[],
  minOverlap: number = 3,
): string[] | null {
  const maxRun = Math.min(sentTail.length, captured.length)
  if (maxRun === 0) return null
  const minRun = Math.min(minOverlap, sentTail.length)
  for (let run = maxRun; run >= minRun; run--) {
    const block = sentTail.slice(sentTail.length - run)
    for (let at = captured.length - run; at >= 0; at--) {
      let matches = true
      for (let j = 0; j < run; j++) {
        if (captured[at + j] !== block[j]) {
          matches = false
          break
        }
      }
      if (matches) return captured.slice(at + run)
    }
  }
  return null
}

/** Keep the last `max` lines of `sent` plus `fresh`, for the next alignment. */
export function nextTail(sent: readonly string[], fresh: readonly string[], max: number): string[] {
  const all = sent.concat(fresh)
  return all.length > max ? all.slice(all.length - max) : all
}
