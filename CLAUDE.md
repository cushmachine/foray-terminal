# Nest

## Deploy

Run `npm run deploy` to build and restart the app. This does `vite build && pm2 restart nest`. The app prompts connected clients to reload via `VersionBanner`. Do not use the dev server — we deploy straight to prod.

## Build & check

- `npm run build` — typecheck (both client and server tsconfigs) then vite build
- `npm run typecheck` — typecheck only, no build
- `npm run test` — unit tests via `tsx --test` (node test runner, not jest)

## Mobile architecture

The app detects touch devices via `COARSE` (`pointer: coarse` media query). Key differences on mobile:

- **Composer** (`Composer.tsx`) is mobile-only. It's a textarea input bar that pastes finished text into the terminal, avoiding IME ghost characters from typing directly into xterm.
- **Keyboard is a curtain.** The soft keyboard shrinks the viewport; layout adapts via CSS container queries (e.g. hiding the key toolbar).
- **Fixed-size pty.** Mobile terminals use a fixed pty size rather than resizing with the viewport.
- Tapping the terminal directly still works for quick y/n input.
