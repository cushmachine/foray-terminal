// Scrollback for the browser comes from tmux's own history.
//
// tmux tells an attached terminal only what it needs to repaint the screen.
// When more than a screenful arrives at once it paints the end and skips
// the middle, so a browser that builds scrollback from the byte stream ends
// up with holes. tmux's history buffer has every line, so the server reads
// it from there and ships lines to the client as they land. These are the
// pure decisions; the tmux calls and the per-connection state live in
// tmux.ts and ws-handler.ts.
//
// Sizes count tmux rows; lines are what capture-pane -J returns, one per
// line the program wrote, so a wrapped line is one entry however many rows
// it takes. The two never need to agree: sizes decide how many rows to
// capture, and the captured lines are matched against the ones already
// sent by content.

export interface PaneHistoryState {
  /** Rows currently in the pane's history (above the visible screen). */
  size: number
  /** history-limit for the pane: history stops growing here and rotates. */
  limit: number
  /** True while a full-screen app has the alternate screen; history is frozen. */
  alternate: boolean
}

export type HistoryPlan =
  /** Nothing to do. */
  | { kind: 'none' }
  /** Capture the last `count` rows and align them against what was already sent. */
  | { kind: 'sync'; count: number }
  /** Capture everything; the client replaces its copy. */
  | { kind: 'reset' }

/**
 * Rows to fetch when the size cannot say how much is new: at the limit it
 * no longer moves while lines rotate through, and after a resize tmux
 * reflows wrapped rows so it moves without the lines changing. New lines
 * are found by overlap with the last lines sent, so this only has to cover
 * what could have arrived since the previous check.
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
  const window = Math.min(saturatedWindow, state.size)
  // Shrunk: tmux reflowed wrapped rows to a wider pane, or lines came back
  // from history to a taller screen, or the history was cleared. Only the
  // first leaves the client's lines intact; the others fail to align and
  // reset from there.
  if (state.size < known) return { kind: 'sync', count: window }
  if (state.limit > 0 && state.size >= state.limit) return { kind: 'sync', count: window }
  if (state.size === known) return { kind: 'none' }
  return { kind: 'sync', count: state.size - known }
}

export interface Alignment {
  /** The captured lines the client does not have yet, in order. */
  fresh: string[]
  /** The history's tail as tmux has it now, uncapped; what the next alignment matches against. */
  tail: string[]
}

/**
 * Lines in `captured` (a fresh tail of the history) that come after the
 * last lines already sent. Matches the longest run of `sentTail`'s end
 * found in `captured`, searching from the newest end; a tail too short to
 * give `minOverlap` lines is searched from the oldest end instead. Returns
 * null when they don't overlap at all, meaning the client is too far
 * behind to append and must reset.
 *
 * History rows never change once written, with one exception: a line
 * still being wrapped onto the visible screen is captured as its history
 * part and grows as rows scroll up. So the last sent line also matches a
 * captured line that extends it, and the extension is sent as a line of
 * its own: it starts at column zero on the pane, where tmux's wrap put it.
 * The remembered tail takes the joined line, so the next capture matches.
 */
export function alignHistory(
  sentTail: readonly string[],
  captured: readonly string[],
  minOverlap: number = 3,
): Alignment | null {
  const maxRun = Math.min(sentTail.length, captured.length)
  if (maxRun === 0) return null
  const minRun = Math.min(minOverlap, sentTail.length)
  const last = sentTail[sentTail.length - 1]
  const extends_ = (line: string): boolean => last !== '' && line.length > last.length && line.startsWith(last)
  // A tail shorter than the overlap it would want is the whole history as
  // it was, so it sits at the oldest end of the capture: a blank line or a
  // prompt that recurs nearer the new end is a later line, not the tail.
  const oldestFirst = sentTail.length < minOverlap
  for (let run = maxRun; run >= minRun; run--) {
    const block = sentTail.slice(sentTail.length - run)
    const lastStart = captured.length - run
    for (let i = 0; i <= lastStart; i++) {
      const at = oldestFirst ? i : lastStart - i
      let matches = true
      for (let j = 0; j < run - 1; j++) {
        if (captured[at + j] !== block[j]) {
          matches = false
          break
        }
      }
      if (!matches) continue
      const end = at + run - 1
      const grown = captured[end]
      if (grown === last) {
        return { fresh: captured.slice(end + 1), tail: sentTail.concat(captured.slice(end + 1)) }
      }
      if (extends_(grown)) {
        return {
          fresh: [grown.slice(last.length), ...captured.slice(end + 1)],
          tail: sentTail.slice(0, -1).concat(captured.slice(end)),
        }
      }
    }
  }
  return null
}

/** The last `max` of `lines`, for the next alignment. */
export function nextTail(lines: readonly string[], max: number): string[] {
  return lines.length > max ? lines.slice(lines.length - max) : [...lines]
}
