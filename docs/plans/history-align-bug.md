# Triplicate / dropped scrollback lines on desktop (2026-09-11)

Diagnosis from a parallel investigation (Opus, read-only, measured against
4,000 lines of this box's real Claude Code scrollback). Hand this to the
session fixing the bug. Nothing here has been applied.

## Not the cause (verified live)

- Not the deploy: `git diff ed4fffb..HEAD` over `src/terminal/`,
  `src/server/history.ts`, `src/ansi.ts`, `src/App.tsx`, `src/styles.css`
  is empty apart from three identifier renames. The server runs with
  `FORAY_TMUX_SOCKET=` (empty), so every tmux call is unchanged.
- Not a stale bundle: every desktop `client:hello` since 13:33 reports
  build `5558e44`, which is HEAD.
- Not multiple tmux clients or pty size drift: one `attach-session -t $37`,
  one client at 194x52, every pane at its client's size. The per-connection
  queue serializes attach and resize, so a resize cannot hit the
  `!attachment?.pty` drop in `ws-handler.ts`.
- Not a duplicate listing: `PREFIX_RE` yields each session once.

## The cause: `alignHistory` in `src/server/history.ts`

Two false matches, both reachable with real Claude Code output (status bar
rows repeat; many lines share prefixes):

1. **Growing-line branch fires mid-capture.** `extends_` (`history.ts:96`,
   used at `:119`) is tested at any `end`, not only at the newest captured
   line. A captured line that merely *starts with* the last sent line makes
   the code emit `grown.slice(last.length)` as a standalone row (the
   `ning—` fragments in the screenshots) and re-anchor `tail` on a line the
   client already has, so the block after it is sent again (the repeated
   status rows). Measured: 6 reachable positions per 4,000 lines.
2. **Short exact match anchors on the wrong occurrence.** `minOverlap` is 3
   (`:91`) and the search runs newest-first (`:103`), so a repeated 3-line
   block (450 per 4,000 lines, 11%) matches its *latest* occurrence and
   `fresh = captured.slice(end + 1)` skips the lines between. xterm has
   `scrollback: 0`, so those lines are gone: the dropped lines.

Contributing: `syncHistory` reads `history_size` and captures in two tmux
calls (`ws-handler.ts:329`, `:339`/`:355`) while history moves, then stores
the earlier size as `tracker.known` (`:347`); and `plan.count` is rows while
`HISTORY_TAIL` is lines, so `count + 50` rows can reach back fewer than 50
lines when the tail wraps.

Why desktop only: the pty resizes with the viewport; each resize reflows
tmux history, moving `history_size` without changing lines, which pushes
`planHistoryUpdate` onto the mis-sized sync path (`HISTORY_REFLOW_MS`
exists for this). Mobile's fixed pty size almost never takes that path.
Why now: the deploy killed every pty, so every client replayed a full reset
plus a long run of incremental syncs, with two desktop tabs contending for
the window.

## Minimal fix (both in `src/server/history.ts`)

1. `:119`: `if (extends_(grown))` becomes
   `if (end === captured.length - 1 && extends_(grown))`. A line still being
   wrapped onto the screen is by definition the last history line.
2. `:101-126`: after a run matches at `at`, check whether any other position
   matches the same run; if so `return null` so `syncHistory` falls through
   to a full reset (`ws-handler.ts:353-359`). A reset costs one capture; a
   mis-anchor costs correctness. Raising `minOverlap` to ~12 is the cheaper
   half-measure.

Optional, separate: capture first and derive the size from the same call
(or re-read `history_size` after the capture) so `tracker.known` is not a
stale row count.

## Red tests first (`src/server/__tests__/history.test.ts`)

- `sentTail` whose last line is a strict prefix of a mid-capture line with
  matching predecessors: `fresh` must contain no bare suffix fragment.
- `captured` containing the same 3-line block twice: `alignHistory` returns
  `null` rather than anchoring on the later one.

Run: `npx tsx --test src/server/__tests__/history.test.ts src/server/__tests__/history-join.test.ts`

Live check: on a throwaway socket (`FORAY_TMUX_SOCKET=foray-test`, as
`npm run test:e2e` does), print numbered lines in bursts larger than a
screen while resizing the pty, then diff the rendered history against
`capture-pane -J`. Without the resize it stays on the happy path, which is
why a line-only simulation comes back clean.

## Also seen

- The desktop had two Foray tabs open (two sockets). Handoff handles it,
  but it doubles attach and history-reset churn. Close one while testing.
- `attachToPane` runs `tmux attach-session` without `-d`; only Foray's own
  bookkeeping prevents a second client. A manual `tmux attach` from a shell
  reproduces this symptom class by design.
