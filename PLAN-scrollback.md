# Nest: Scrollback from tmux history — Plan

Status: approved 2026-09-04. Orchestrated by Claude Code; chunks built by
sub-agents; the orchestrator verifies, deploys, and commits.

## Why

tmux tells an attached terminal only what it needs to repaint the screen.
When more than a screenful of output arrives at once it paints the end and
skips the middle. Measured on 2026-09-04: a 300-line burst put 289 lines
in tmux's history and only 26 line-scrolls reached the browser. On a phone
(about 20 rows) nearly every Claude Code response is such a burst, so
responses arrived with their tops missing.

Everything tried so far builds the browser's scrollback out of that byte
stream (keeping tmux off the alternate screen, replaying history into
xterm on attach, disabling tmux's "scroll N lines" code). All of it
inherits the holes. tmux's own history buffer has every line, so that is
where scrollback must come from.

## Design

```
  Claude Code ──► tmux ──► Nest server ──► browser
                   │            │            ├── history: HTML rows, fed from
                   │            │            │   tmux history via the server
                   │  history ──┘ (capture-pane)
                   │                         └── live screen: xterm.js, fed by
                   └── screen repaints ──────────  tmux's repaint stream
```

- xterm.js shows only the live screen. `scrollback: 0`; tmux goes back to
  the alternate screen (default terminal-overrides), so the stream never
  scrolls xterm.
- History is tmux's history. The server reads it with `capture-pane` and
  ships lines to the client as `terminal:history` messages: a full set on
  attach (`reset: true`), then increments as lines scroll off the pane.
- The client renders history lines as HTML rows in a scroll container
  stacked above the xterm element. Scrolling, momentum, and text selection
  are the browser's own. The view sticks to the bottom until the user
  scrolls up.
- Reconnects re-attach and get a fresh full set, so gaps from a dropped
  connection close by themselves.

## Protocol (already applied in `src/shared/protocol.ts`)

```typescript
// Server → client. Oldest first, colour escapes intact.
{ type: 'terminal:history', windowId: number, lines: string[], reset: boolean }
```
`TerminalAttachMessage` no longer carries `history`.

## Current working tree (uncommitted, keep)

- `src/server/history.ts` — NEW. Pure decisions: `planHistoryUpdate`,
  `alignHistory`, `nextTail`, `SATURATED_WINDOW`. Read it before Chunk H.
- `src/server/tmux.ts` — `captureHistory` replaced by `paneHistoryState`
  (parses `#{history_size} #{history_limit} #{alternate_on}`) and
  `captureHistoryLines(sessionId, count)` (rows as displayed, no `-J`;
  count 0 returns [] without calling tmux).
- `src/shared/protocol.ts` — `TerminalHistoryMessage` added to
  `ServerMessage`; `history?: boolean` removed from attach.
- `src/server/index.ts` — STILL imports `captureHistory` and replays it on
  attach. Build is broken until Chunk H lands.
- `src/server/__tests__/chunkA.test.ts` — still imports and tests
  `captureHistory`. Chunk H replaces those tests.

## Chunks

### Chunk H: server history tracker

Files: `src/server/index.ts`, `src/server/__tests__/chunkA.test.ts`,
new `src/server/__tests__/chunkH.test.ts`, `package.json` (add
`"test:chunkH": "tsx src/server/__tests__/chunkH.test.ts"`).

In `index.ts`, per WebSocket connection, next to `ptys`:

```typescript
interface HistoryTracker {
  known: number | null      // history size the client has; null = nothing sent
  sentTail: string[]        // last HISTORY_TAIL lines sent, for alignment
  timer: ReturnType<typeof setTimeout> | null
  running: boolean
  dirty: boolean            // output arrived while a sync was running
}
const HISTORY_CHECK_MS = 80
const HISTORY_TAIL = 50
```

- `scheduleHistory(windowId)`: mark dirty; if no timer and not running,
  set a timer for `HISTORY_CHECK_MS` that calls `syncHistory(windowId)`.
- `syncHistory(windowId, force = false)`:
  1. `state = await paneHistoryState(windowId)`.
  2. `plan = planHistoryUpdate(force ? null : tracker.known, state)`.
  3. `none`: return (leave `known` untouched when `state.alternate`).
  4. `reset`: `lines = await captureHistoryLines(windowId, state.size)`;
     `sentTail = nextTail([], lines, HISTORY_TAIL)`; `known = state.size`;
     send `{ type: 'terminal:history', windowId, lines, reset: true }`.
  5. `sync`: `captured = await captureHistoryLines(windowId,
     Math.min(state.size, plan.count + HISTORY_TAIL))`;
     `fresh = alignHistory(tracker.sentTail, captured)`. If `fresh` is
     null, do step 4 (the client is too far behind, or nothing was ever
     sent). Otherwise, if `fresh.length > 0`, update `sentTail` with
     `nextTail` and send `{ ..., lines: fresh, reset: false }`.
     Set `known = state.size`.
  6. Errors: `console.error('[ws] history sync error:', err)`; never
     throw out of the handler.
  7. `finally`: `running = false`; if `dirty` and the tracker still
     exists, `scheduleHistory` again.
- `terminal:attach`: delete the replay block. After killing any existing
  pty, create a fresh tracker for the window, `await syncHistory(id,
  true)`, then spawn the pty. In the pty `onData` callback, after
  `send(...)`, call `scheduleHistory(msg.windowId)`.
- `terminal:resize`: after `handle.resize`, `setTimeout(() =>
  syncHistory(id, true), 150)` so the client gets tmux's reflowed history.
- Wherever a pty is killed (re-attach on the same connection, `close`),
  clear the tracker's timer and delete it.
- Update the `./tmux.ts` import (`paneHistoryState`,
  `captureHistoryLines`) and import from `./history.ts`.

Tests, `chunkH.test.ts` (pure, no tmux): `planHistoryUpdate` — alternate
→ none; known null → reset; size < known → reset; size ≥ limit → sync with
`min(SATURATED_WINDOW, size)`; size == known → none; growth → sync with the
delta. `alignHistory` — plain growth appends only the new lines; captured
tail entirely new (no overlap) → null; empty sentTail → null; rotation at
the limit (sentTail's last lines sit mid-window) → the lines after them;
repeated identical lines prefer the longest run; `nextTail` caps length.

Tests, `chunkA.test.ts`: replace the two `captureHistory` tests with:
`paneHistoryState` parses `"120 2000 0\n"` and `alternate` from `"5 2000
1\n"`; `captureHistoryLines(7, 3)` calls `capture-pane` with
`['-S', '-3', '-E', '-1']` and `'$7'`, splits lines and drops the trailing
empty one; `captureHistoryLines(7, 0)` returns `[]` and never calls tmux.

Acceptance: `npm run test:chunkA`, `npm run test:chunkH` pass;
`npx tsc --noEmit -p .` shows no errors under `src/server/` or
`src/shared/`.

### Chunk I: ANSI colour renderer

Files: new `src/ansi.ts`, new `src/__tests__/chunkI.test.ts`,
`package.json` (add `"test:chunkI": "tsx src/__tests__/chunkI.test.ts"`).

API (Chunk J depends on exactly this):

```typescript
export interface Palette {
  colors: string[]      // 256 CSS colours: 16 theme, 216 cube, 24 greys
  foreground: string
  background: string
}
export interface ThemeColors {  // the shape of THEME in Terminal.tsx
  foreground: string; background: string
  black: string; red: string; green: string; yellow: string
  blue: string; magenta: string; cyan: string; white: string
  brightBlack: string; brightRed: string; brightGreen: string; brightYellow: string
  brightBlue: string; brightMagenta: string; brightCyan: string; brightWhite: string
}
export function paletteFromTheme(theme: ThemeColors): Palette
/** One captured row → HTML. Escapes text; wraps styled runs in <span style="...">. */
export function ansiLineToHtml(line: string, palette: Palette): string
```

Behaviour: handle SGR (`ESC [ ... m`) codes 0, 1, 2, 3, 4, 7, 9, 22, 23,
24, 27, 29, 30–37, 39, 40–47, 49, 90–97, 100–107, `38;5;n`, `48;5;n`,
`38;2;r;g;b`, `48;2;r;g;b`, including several codes in one sequence. Any
other escape sequence (other CSI finals, OSC `ESC ]...BEL|ESC \`, lone
ESC + char) is dropped silently. Bold with a 30–37 colour uses the bright
colour, matching xterm's default. Inverse swaps foreground and background,
falling back to the palette defaults. Dim → `opacity:0.6`. Plain text
comes out with no wrapper. HTML-escape `& < > "`. Output for an empty
line is `''`. Styles are emitted as `color`, `background-color`,
`font-weight:700`, `font-style:italic`, `text-decoration` (underline and
line-through combine), `opacity`.

Tests: plain text with `<&>` escaped; single colour run then reset; two
styles in one sequence (`1;31`); 256-colour index 196 and grey 244;
truecolor; bold+basic colour → bright; inverse with defaults; unknown CSI
(`ESC[2J`) and OSC (`ESC]0;title BEL`) stripped; trailing reset produces
no empty span; empty line → `''`; palette has 256 entries and `colors[0]`
equals `theme.black`, `colors[9]` equals `theme.brightRed`,
`colors[16]` is `#000000`, `colors[231]` is `#ffffff`.

Acceptance: `npm run test:chunkI` passes; `npx tsc --noEmit -p .` shows no
errors in `src/ansi.ts`.

### Chunk J: client layout (after I)

File: `src/Terminal.tsx` only.

- xterm options: `scrollback: 0`. Everything else unchanged.
- Markup inside the root div (keep the root's drag handlers and the
  overlays exactly as they are):
  ```
  <div ref={scrollRef} style={{ height: '100%', overflowY: 'auto',
       overscrollBehavior: 'contain', WebkitOverflowScrolling: 'touch',
       background: THEME.background }}>
    <div ref={historyRef} style={{ fontFamily: <same as xterm>,
         fontSize, lineHeight: 1.4, whiteSpace: 'pre-wrap',
         wordBreak: 'break-all', padding: '0 8px',
         color: THEME.foreground }} />
    <div ref={containerRef} style={{ height: '100%', padding: 8 }} />
  </div>
  ```
  The xterm container's `height: 100%` resolves against the scroll
  container's client height, so the live screen is always one full page
  and the history above it makes the container scroll.
- History DOM is managed directly, not through React state. On
  `terminal:history` for this window: if `reset`, `replaceChildren()`;
  then append one `<div>` per line via a DocumentFragment, with
  `innerHTML = ansiLineToHtml(line, palette) || '&nbsp;'` (an empty div
  has no height). Keep at most `MAX_HISTORY_LINES = 3000` rows, removing
  from the top. Build `palette` once with `paletteFromTheme(THEME)`.
- Sticky bottom: `stickRef` (true initially). A `scroll` listener on the
  scroll container sets it to `scrollTop + clientHeight >= scrollHeight -
  4`. After appending history, after each `term.write` (use the write
  callback), and inside the ResizeObserver callback, if stuck, scroll to
  the bottom in a `requestAnimationFrame`. When `fontSize` changes, also
  update `historyRef.current.style.fontSize`.
- Wheel over the live screen must scroll the page, not xterm: a
  capture-phase `wheel` listener on `containerRef` does
  `scrollRef.current.scrollTop += deltaY` (multiply by the row height
  when `deltaMode === 1`), then `preventDefault()` and
  `stopPropagation()`.
- Remove: the touch/fling code and its constants, `touchAction: 'none'`,
  `history: true` on the initial attach, and the obsolete comment about
  reconnects not replaying.
- Keep: `nest:submit`, `nest:paste`, `nest:sendkeys` handlers, upload
  handling, detached overlay, resize reporting.

Acceptance: `npx tsc --noEmit -p .` shows no errors in `src/Terminal.tsx`;
`npm run build` succeeds (orchestrator runs it after H and I).

### Chunk K: isolated end-to-end check (orchestrator; scratch script)

Never through the live server. Start a private instance:
`PORT=3999 TMUX_TMPDIR=/tmp/nest-probe npx tsx src/server/index.ts`
(both tmux and node-pty inherit the env, so it gets its own tmux server).
Probe over `ws://localhost:3999/ws`: create a session, attach at 50×20,
wait for the prompt, `seq 1 300`, collect `terminal:history` messages for
3 s. Assert: the first message is `reset: true`; after stripping escapes,
the concatenated lines contain 1..300 in order with no duplicates; resize
to 60×20 produces a `reset: true` message. Kill the session, stop the
server, `TMUX_TMPDIR=/tmp/nest-probe tmux kill-server`.

## Config and deploy (orchestrator)

1. `~/.tmux.conf`: drop the `terminal-overrides` line and its comments
   (tmux returns to the alternate screen); keep `set -g mouse off`; add
   `set -g history-limit 10000`; `tmux source-file ~/.tmux.conf`.
2. `npm run build`, `pm2 restart nest`. Every client re-attaches and gets
   the full history.
3. Commit (message explains the measurement and the design), push.
4. Update the machine memory note.

## Rollback

`git revert` the commit, restore the `terminal-overrides` line to
`'linux*:AX@,xterm*:smcup@:rmcup@:indn@'`, rebuild, restart.

## Rules for sub-agents

- Do not run `pm2`, touch port 3000, or create tmux sessions on the
  default socket. Any tmux experiment uses `TMUX_TMPDIR=/tmp/nest-probe`.
- Do not commit and do not run `npm run build`; the orchestrator does both.
  Typecheck with `npx tsc --noEmit -p .` and read only the errors in your
  files (other chunks may be mid-flight).
- Match the existing style: comments explain why, not what; no chat
  formatting inside code; sentence-case prose.
- Report back: files changed, test output, anything you deviated from.
