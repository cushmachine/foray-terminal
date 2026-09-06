# Nest Visual & Interaction Audit

Automated Playwright battery: 34 tests across desktop (1440x900), tablet (768x1024), mobile (390x844), mobile landscape (844x390), stress scenarios (rapid create, rapid switch, resize during output, narrow viewport, viewport transitions). 41 screenshots analyzed.

**Result: 32 passed, 2 failed.** Zero console errors.

---

## Critical Bugs

### 1. Mobile sidebar close button is outside the viewport
- **Severity:** P0 — blocks mobile sidebar use in automated/programmatic flows
- **Observed:** Playwright tests 22 and 27 timed out. The sidebar close button (`‹`) is detected as "visible" (exists in DOM, not `display:none`) but positioned "outside of the viewport" — Playwright can't click it. This suggests the button overflows its container or is positioned beyond the visible safe area.
- **Repro:** Open sidebar on 390x844 viewport, try to tap the `‹` close button.
- **Fix:**
  - [ ] Audit the close button's position in `Sidebar.tsx` — ensure it stays within the sidebar's visible bounds including safe-area insets
  - [ ] Verify the sidebar's `width: min(300px, 85vw)` doesn't push the close button past the right edge
  - [ ] Test with `env(safe-area-inset-*)` padding — the button may be under the notch area
  - [ ] Add `data-testid="sidebar-close"` for reliable test targeting

### 2. Terminal canvas not found by Playwright
- **Severity:** P1 — blocks automated terminal interaction testing
- **Observed:** Test 03 fell through to "no-terminal-canvas" — `page.locator('canvas').first()` found nothing. The terminal IS rendering (visible in all screenshots showing terminal output), so xterm.js is likely using the DOM renderer instead of the WebGL/canvas renderer.
- **Impact:** Automated tests can't click/interact with the terminal via canvas selector. Keyboard input still works (test 13 confirmed typing reached the terminal). But this means xterm.js isn't using GPU-accelerated rendering, which may contribute to lag.
- **Fix:**
  - [ ] Check if `@xterm/addon-webgl` is installed and loaded — it enables canvas-based rendering with better performance
  - [ ] If WebGL addon isn't viable, update Playwright selectors to target `.xterm-screen` or the xterm container div instead of `canvas`
  - [ ] Consider adding the WebGL addon for performance: `npm install @xterm/addon-webgl` and `term.loadAddon(new WebGLAddon())` with a DOM-renderer fallback

---

## Visual Bugs

### 3. Mobile sidebar doesn't fully obscure the terminal behind it
- **Severity:** P2
- **Observed:** In mobile sidebar screenshots, terminal text bleeds through on the right side behind the sidebar. The sidebar is `min(300px, 85vw)` — on a 390px screen that's 300px, leaving 90px of terminal visible with no overlay dimming it.
- **Fix:**
  - [ ] Verify the backdrop overlay (`rgba(0,0,0,0.6)` div in `App.tsx`) is rendering on mobile when sidebar is open
  - [ ] If the overlay exists, ensure it covers the full viewport and has a high enough z-index
  - [ ] Consider making the sidebar full-width on very narrow screens (`< 400px`)

### 4. Session list sorts lexicographically, not numerically
- **Severity:** P3 — cosmetic
- **Observed:** With 10+ sessions, sidebar shows: bash-1, bash-10, bash-2, bash-3... instead of bash-1, bash-2, bash-3... bash-10.
- **Fix:**
  - [ ] Sort sessions in `sessionState.ts` or `Sidebar.tsx` using a natural-sort comparator that handles trailing numbers
  - [ ] Or: sort by session id (numeric) instead of name

### 5. Key toolbar clipping at narrow viewports
- **Severity:** P3 — cosmetic
- **Observed:** At 320px width, the rightmost key toolbar buttons are partially cut off. The toolbar scrolls horizontally but there's no visual indicator that more buttons exist.
- **Fix:**
  - [ ] Add a subtle fade/gradient on the right edge of the key toolbar when it overflows, hinting at scrollability
  - [ ] Or: wrap buttons to a second row at very narrow widths
  - [ ] Or: reduce button padding at narrow viewports

### 6. Tablet file panel squeezes terminal to ~30% width
- **Severity:** P2
- **Observed:** At 768px with sidebar + file panel both open, the terminal column is extremely narrow (~230px). Terminal text wraps every few characters, making it nearly unusable.
- **Fix:**
  - [ ] On tablet-width viewports, auto-collapse the sidebar when the file panel opens
  - [ ] Or: treat 768px as mobile layout (overlay sidebar instead of inline)
  - [ ] Or: set a minimum terminal width and let the file panel shrink first

### 7. Session name truncation with no tooltip
- **Severity:** P3 — polish
- **Observed:** Long session names like "zsh conventio..." and "App code comp..." are truncated with ellipsis. No way to see the full name without renaming.
- **Fix:**
  - [ ] Add `title={session.name}` to session buttons in `Sidebar.tsx` for native browser tooltips
  - [ ] Or: show full name in the top bar when that session is active (already partially done — top bar shows `› bash-1`)

---

## Interaction Issues

### 8. Terminal scrollback not testable (canvas issue)
- **Severity:** P2 — functional gap
- **Observed:** Tests 11 (scrollback output), 12 (large paste), 28 (mobile scroll) produced no terminal-specific screenshots because the canvas wasn't found. Cannot verify scrollback behavior programmatically.
- **Root cause:** Same as bug #2 — DOM renderer doesn't expose a canvas.
- **Fix:** Resolving bug #2 (WebGL addon) fixes this. Alternatively, test scrollback by examining xterm.js's buffer API from the page context.

### 9. No keyboard shortcut for sidebar toggle
- **Severity:** P3 — usability
- **Observed:** Sidebar toggle requires clicking the `◂`/`▸` button. No keyboard shortcut (e.g., Cmd+B) exists.
- **Fix:**
  - [ ] Add a global keyboard listener for `Cmd+B` or `Ctrl+B` to toggle the sidebar
  - [ ] Add `Cmd+\` to toggle the file panel (matching VS Code convention)

### 10. Desktop shows mobile key toolbar
- **Severity:** P3 — polish (may be intentional)
- **Observed:** The esc/tab/ctrl/arrow key toolbar renders on desktop viewports too. Desktop users have physical keyboards, so this is clutter.
- **Fix:**
  - [ ] Only show the key toolbar on mobile/touch viewports (check `isMobile` or `pointer: coarse`)
  - [ ] Or: make it collapsible on desktop with a toggle

### 11. "New session" button at bottom requires scrolling past all sessions
- **Severity:** P3 — usability
- **Observed:** With 10 sessions, the "+ new session" button is below the fold. Must scroll the entire session list to reach it.
- **Fix:**
  - [ ] Pin the "+ new session" button to the bottom of the sidebar (already in a separate `<div>` with `borderTop` — may just need `position: sticky; bottom: 0`)
  - [ ] Verify it stays visible when the session list scrolls

---

## Stress Test Results

### 12. Rapid session creation (5 sessions) — PASSED
- No visual glitches, all sessions appeared correctly in sidebar.

### 13. Rapid session switching (10 switches in 2s) — PASSED
- Terminal switched cleanly each time, no ghost rendering or stale content.

### 14. Resize during terminal output — NOT TESTABLE
- Terminal canvas not found, so output generation didn't execute. Would need manual verification or WebGL addon fix.

### 15. Very narrow viewport (320x568) — PASSED with cosmetic issues
- Layout didn't break. Sidebar still functional. Key toolbar clipping noted (bug #5).

### 16. Desktop-to-mobile transition — PASSED
- Layout transitions cleanly between 1440px and 390px viewports. Sidebar correctly switches from inline to overlay mode.

---

## User-Reported Issues (from prior sessions, not tested here)

### 17. Copy-paste from terminal to system clipboard unreliable
- **Severity:** P1
- **Observed:** User reported inability to copy text from the terminal. ClipboardAddon was added but may not be fully functional.
- **Fix:**
  - [ ] Verify `ClipboardAddon` is working — test Cmd+C after selecting text in the terminal
  - [ ] Check if the clipboard API is available (requires HTTPS — should be fine via Tailscale)
  - [ ] If ClipboardAddon doesn't work with DOM renderer, try hooking into xterm's selection API manually: `term.onSelection(() => navigator.clipboard.writeText(term.getSelection()))`

### 18. Shift+Enter not working in nested Claude Code sessions
- **Severity:** P1
- **Observed:** User reported Shift+Enter doesn't work when running Claude Code inside Nest's terminal. Works fine in native terminal.
- **Fix:**
  - [ ] Audit how the terminal handles modifier+key combos — Shift+Enter should send `\x1b[13;2u` or `\r` depending on terminal mode
  - [ ] Check if the Composer/input bar intercepts Enter/Shift+Enter before it reaches the terminal
  - [ ] Test with `showkey -a` in the terminal to verify what byte sequences arrive

### 19. Visual artifacts appearing mid-flow
- **Severity:** P1
- **Observed:** User shared a screenshot showing rendering artifacts (horizontal lines, misaligned text) in the terminal while using Claude Code. May be related to DOM renderer limitations or ANSI escape sequence handling.
- **Fix:**
  - [ ] Adding WebGL renderer (bug #2 fix) may resolve rendering artifacts
  - [ ] If artifacts persist, audit the ANSI parser (`src/ansi.ts`) for edge cases in Claude Code's output (progress bars, spinners, cursor movements)

---

## Cleanup Tasks

### 20. Remove test sessions from VM
- [ ] Kill all `bash-N` sessions created by the stress tests: `tmux kill-session -t nest_bash-1` etc. or script it
- [ ] Consider adding a "kill all idle sessions" feature or auto-cleanup for sessions idle > N hours

### 21. Add test infrastructure
- [ ] Add `data-testid` attributes to key interactive elements (sidebar close, session items, file panel toggle, terminal container) for reliable Playwright targeting
- [ ] Move the Playwright audit suite into the repo as a permanent regression test
- [ ] Add a `test:visual` npm script

---

## Priority Order for Fixes

**Do first (blocks usability):**
1. Bug #1 — Mobile sidebar close button viewport issue
2. Bug #2 — Add WebGL renderer for terminal (fixes #8, #14, #19, improves performance)
3. Bug #17 — Copy-paste reliability
4. Bug #18 — Shift+Enter in nested sessions

**Do second (improves experience):**
5. Bug #3 — Mobile sidebar backdrop
6. Bug #6 — Tablet file panel layout
7. Bug #9 — Keyboard shortcuts for sidebar/file panel toggle

**Do third (polish):**
8. Bug #4 — Natural sort for session names
9. Bug #5 — Key toolbar overflow indicator
10. Bug #7 — Session name tooltips
11. Bug #10 — Hide key toolbar on desktop (if intentional, skip)
12. Bug #11 — Pin "new session" button
13. Bug #21 — Test infrastructure
