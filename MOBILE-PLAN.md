# Nest: Mobile Optimization Plan

Nest is used from a phone as much as from a laptop, but the phone experience
today is fragile: the terminal dies after every app switch, hidden terminals
shrink the real tmux session, and the key toolbar is too small to drive
Claude Code with. This plan fixes the breakage first, then makes the phone a
first-class client.

Same conventions as `PLAN.md`: each chunk lists scope, tests to write first,
and an eval command. Chunks are ordered by payoff. M0 and M1 are bug fixes and
should ship together; everything after is layered polish.

**Status (2026-09-03):** M0–M4 implemented. Unit tests for the mobile work
live in `src/__tests__/chunkM.test.ts` (`npm run test:chunkM`); the socket
tests are in chunkC and the server liveness tests in chunkE. M5 is not
started. The device checklist at the bottom still needs a real phone.

## Findings that drive the order

1. **Reconnect never re-attaches.** The server kills every pty when a socket
   closes (`src/server/index.ts`, `ws.on('close')`). The client reconnects
   with backoff, but `terminal:attach` is only sent from the mount effect in
   `src/Terminal.tsx`. iOS closes the socket whenever the app is backgrounded,
   so on a phone the terminal is dead after every app switch until a reload.
2. **Hiding a terminal resizes the pty to ~8x4.** Session switching and the
   mobile "files" view set the terminal container to `display: none`. The
   ResizeObserver fires, and `FitAddon.proposeDimensions` reads the
   container's computed height as the CSS string `"100%"`, which `parseInt`
   turns into 100 pixels. The resulting tiny `terminal:resize` reaches tmux,
   which redraws Claude Code at that size. The full-size redraw on return
   leaves artifacts in scrollback.
3. **No liveness detection.** No ping/pong in either direction. A phone
   switching Wi-Fi to LTE leaves a half-open socket that looks connected.
4. **The soft keyboard covers the prompt.** The layout is `height: 100%`,
   which on iOS doesn't shrink when the keyboard opens.
5. **Toolbar keys fire on both `touchstart` and the synthesized `mousedown`.**
6. **Every session mounts an xterm and a server pty on load**, so opening
   Nest on a phone takes ownership of every session, kicking the laptop off
   all of them.
7. Touch targets are 22–30px, `window.prompt`/`confirm` are used for rename
   and kill, the manifest has no icons, and the `useIsMobile` check treats a
   landscape phone as a desktop.

---

## Chunk M0: Connection resilience

**Files:** `src/hooks/useSocket.ts`, `src/Terminal.tsx`, `src/server/index.ts`,
`src/shared/protocol.ts`

**Scope:**
- `terminal:attach` gains optional `cols`/`rows` so the pty spawns at the
  right size instead of 80x24 and then resizing (one tmux redraw, not two).
- Terminal re-sends `terminal:attach` (with its current size) whenever the
  socket transitions back to `connected`, unless the user was explicitly
  taken over (`detached`), in which case the overlay stays and they choose.
- App-level heartbeat: client sends `{type:'ping'}` every 25s while
  connected and immediately when the tab becomes visible; server answers
  `{type:'pong'}`. No pong within 10s means the socket is dead: close it and
  reconnect at once (attempt counter reset).
- `visibilitychange` (to visible) and `online` events short-circuit any
  pending backoff and reconnect immediately.
- Server-side protocol ping every 30s; a client that misses a pong is
  terminated so its ptys and ownership are released.

**Tests (write first):**
- `SocketManager`: sends `ping` on the heartbeat interval once connected.
- `SocketManager`: no `pong` within the timeout closes the socket and
  reconnects without waiting for backoff.
- `SocketManager.reconnectNow()`: while disconnected with a pending backoff,
  reconnects immediately and resets the attempt counter.
- Server: `ping` gets a `pong` reply.
- Server: `terminal:attach` with cols/rows spawns the pty at that size.
- Server: a client that never answers protocol pings is terminated after the
  heartbeat interval (short interval via `ServerOptions.heartbeatIntervalMs`).

**Eval:** `npm run test:chunkC && npm run test:chunkA && npm run test:chunk0 && npm run test:chunkE`

---

## Chunk M1: Terminal sizing and mounting

**Files:** `src/Terminal.tsx`, `src/App.tsx`, `src/terminalSize.ts` (new),
`src/hooks/useAppHeight.ts` (new), `src/styles.css`, `index.html`

**Scope:**
- Fit is skipped while the container has zero size; it runs again when the
  container becomes visible. A resize is only sent when cols/rows actually
  changed (tracked per terminal), so tmux stops getting redundant SIGWINCHs.
- The app root is sized from `window.visualViewport` height (published as
  `--app-height`), with `100dvh` as the fallback. The flex layout shrinks
  with it and xterm's ResizeObserver refits, so the prompt and key toolbar
  sit directly above the soft keyboard. A pinch-zoomed viewport is ignored.
- `interactive-widget=resizes-content` in the viewport meta (Android).
- `overscroll-behavior: none` on the body so pull-to-refresh can't reload
  mid-session.
- Terminals mount lazily: an xterm and pty are created the first time a
  session is opened, not for every session on load. Once opened they stay
  mounted so local scrollback survives switching.

**Tests (write first):**
- `terminalSize.ts`: `nextResize(last, cols, rows)` returns null when
  unchanged and the new size when changed.
- `terminalSize.ts`: `canFit(width, height)` is false for zero dimensions.
- `useAppHeight.ts`: `appHeight(visualViewport, fallback)` prefers the visual
  viewport height and falls back when the API is missing or zoomed.
- `sessionState.ts`: `openedWith` adds the active session once; killed
  sessions drop out because rendering filters by the live session list.

**Eval:** `npm run test:chunkM && npx tsc --noEmit`

---

## Chunk M2: Touch ergonomics

**Files:** `src/App.tsx`, `src/Sidebar.tsx`, `src/KeyToolbar.tsx`,
`src/FilePanel.tsx`, `src/styles.css`, `src/mobile.ts` (new), `index.html`

**Scope:**
- `useIsMobile` uses `matchMedia`: width under 768px, or a coarse pointer
  with height under 500px (landscape phone). One source of truth; the
  duplicated `innerWidth` check in `selectSession` goes away.
- Toolbar keys use a single pointer path: send on `pointerup` for a tap, on
  a timer for a hold, never on `click`. `pointerdown` is default-prevented so
  the terminal keeps focus and the soft keyboard stays up. Rows are
  `touch-action: pan-x`, so a sideways drag scrolls instead of firing.
  Long-press context menus are suppressed.
- Every tap target is at least 44px on mobile: hamburger, session rows,
  rename and kill, file tree rows, toolbar keys, top bar toggles.
- Sidebar: safe-area top padding; swipe from the left edge opens, swipe left
  closes; rename is an inline text field; kill is a two-tap confirm instead
  of `window.confirm`. The hardcoded IP becomes `location.host`.
- Top bar: session name and cwd truncate with ellipsis on one line.
- Terminal font: 13px on phones, with −/+ controls in the sidebar footer
  that persist to localStorage and refit on change. Pinch zoom stays disabled
  (`maximum-scale=1` also prevents iOS auto-zoom on the 13px editor).
- Safe-area insets move off `body` and into the bars that touch the screen
  edges, so the toolbar's surface color fills to the bottom edge like a
  native tab bar. `apple-mobile-web-app-status-bar-style: black-translucent`.

**Tests (write first):**
- `mobile.ts`: `isMobileViewport({width, height, coarse})` for phone
  portrait, phone landscape, tablet portrait, desktop.
- `mobile.ts`: `clampFontSize(n)` keeps 10–22 and `readFontSize` falls back
  on garbage.
- (Rename and kill state stayed inside the Sidebar component; it's two
  `useState`s and not worth a reducer.)

**Eval:** `npm run test:chunkM && npx tsc --noEmit`

---

## Chunk M3: A key toolbar that can drive Claude Code

**Files:** `src/keys.ts` (new), `src/KeyToolbar.tsx`, `src/Terminal.tsx`,
`src/__tests__/chunkM.test.ts`

**Scope:**
- Key table lives in `src/keys.ts` as data: Esc, Tab, Shift-Tab (Claude Code
  mode toggle), Enter, arrows, Home/End, PgUp/PgDn, Backspace, Ctrl-C/D/Z/R/L/U,
  and the symbols `/ - | ~ \ _`.
- Sticky Ctrl and Alt modifiers: tap Ctrl, then any key from the phone
  keyboard sends the control sequence. `applyModifiers(char, mods)` is pure.
- Hold-to-repeat on arrows and Backspace (initial 400ms, then 60ms).
- Paste button: `navigator.clipboard.readText()` into the terminal, since
  pasting into xterm's hidden textarea on iOS is unreliable.
- Photo button: `<input type="file" accept="image/*">` feeding the existing
  `uploadFiles` path from the image upload work.
- Two rows on mobile (primary + secondary), one scrolling row on desktop.
- Haptic tick via `navigator.vibrate(8)` where available.

**Tests (write first):**
- `keys.ts`: every key maps to the expected escape sequence.
- `applyModifiers`: Ctrl-a..z map to 0x01..0x1a; Alt prefixes ESC; Ctrl on
  a non-letter is a no-op.
- `repeatSchedule`: yields the initial delay then the repeat delay.

**Eval:** `npm run test:chunkM && npx tsc --noEmit`

---

## Chunk M4: PWA install polish

**Files:** `public/manifest.json`, `public/icons/*`, `public/sw.js`,
`index.html`, `src/main.tsx`, `scripts/make-icons.mjs` (new)

**Scope:**
- Icons: 192 and 512 PNG, a maskable 512, and an `apple-touch-icon`. Generated
  by `npm run icons` (`scripts/make-icons.mjs`, plain node, no image
  libraries), so they're reproducible.
- CodeMirror is loaded on demand (`React.lazy` in FilePanel): it was a third
  of the bundle and only matters once a file is open.
- Manifest: icons, `id`, `orientation: any`, `scope`.
- A minimal service worker: precache the shell on install, network-first with
  cache fallback for navigations and same-origin assets, never touching `/ws`
  or `/api`. Registered in production only. Gives instant launch and a
  friendly "can't reach nest" screen instead of a white page.

**Tests (write first):**
- Manifest parses, every icon it references exists in `public/`, and each PNG
  has the declared dimensions (read from the IHDR chunk).
- `sw.js` never caches `/ws` or `/api` paths (pure `shouldCache(url)` helper
  shared with the worker).

**Eval:** `npm run test:chunkM && npm run build`

---

## Chunk M5: Session navigation and copy (optional)

**Scope:**
- Swipe left/right on the terminal (with a two-finger or edge gesture, so
  xterm's own touch scrolling keeps working) switches sessions.
- A "select" toggle in the toolbar that switches xterm into selection mode on
  mobile, with a copy button that uses `navigator.clipboard.writeText`.
- Bottom session strip on mobile as an alternative to the drawer.

**Eval:** manual device pass.

---

## Device checklist (after M0–M4)

Run over Tailscale against the VM, on iOS Safari (tab and Home Screen) and
Chrome Android, portrait and landscape:

- [ ] Background the app for 2 minutes, return: terminal is live, no reload.
- [ ] Toggle Wi-Fi off/on: reconnects within ~10s, terminal live.
- [ ] Switch sessions three times: no size artifacts in either session.
- [ ] Tap "files", then "term": terminal at full size, no garbage.
- [ ] Focus the terminal: prompt and toolbar visible above the keyboard.
- [ ] Rotate: refits without a reload.
- [ ] Each toolbar key sends exactly once.
- [ ] Shift-Tab toggles Claude Code's mode.
- [ ] Ctrl (sticky) then `c` sends Ctrl-C.
- [ ] Paste and photo buttons work.
- [ ] Add to Home Screen shows the Nest icon; launch has no white flash.
