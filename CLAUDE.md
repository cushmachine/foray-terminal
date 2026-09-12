# Foray

Instructions for coding agents working on Foray itself. This is not user documentation — the README is.

## Deploy

Run `npm run deploy` to build and restart the app. It runs `scripts/deploy.sh`, which typechecks first (a type error aborts before pm2 is touched), then restarts Foray under pm2, or relaunches it from `ecosystem.config.cjs` when that file changed (pm2 does not pick up a changed script or interpreter on a plain restart). pm2 runs `scripts/start.sh`, which builds the client and then starts the server, so every restart is a full deploy and the server and page stamps always match. The app prompts connected clients to reload via `VersionBanner`. Foray has no dev server; a deploy is the only way to run it. Never run `pm2 restart` or `pm2 start` by hand; use `npm run deploy`.

Prod runs from the checkout with `tsx` and builds with `vite`, so the dev dependencies must be installed on the box (`npm install`, never `--omit=dev`).

## Sessions live in foray-tmux.service

The tmux server that holds every session runs in its own systemd unit, `foray-tmux.service` (generated and installed by `scripts/ensure-tmux-unit.sh`, run from `start.sh` on every deploy), not under pm2. So a deploy, a pm2 crash, or an OOM teardown of pm2 leaves sessions alive. Never `systemctl stop` or `restart foray-tmux`: that kills every session. Foray runs on its own tmux socket (`tmux -L foray ls`; `FORAY_TMUX_SOCKET`, default `foray`), never the machine's default one, so it never touches a tmux server you already run. To recover a lost agent session, the sidebar's Past sessions list revives one from its transcript; by hand, the session ids are the transcript filenames under `~/.claude/projects/`, and `claude --resume <uuid>` inside a new `foray_<name>` tmux session on that socket does the same thing.

On macOS there is no unit: `start.sh` skips it, and the tmux server survives pm2 restarts on its own because macOS has no cgroups. Boot persistence there is a LaunchAgent written by `install.sh` (see DEPLOY.md).

## Security

Foray is a shell on the box: every socket and upload needs the access
token (`src/server/auth.ts`; `~/.foray/token`, printed by `npm run token`),
the browser holds a cookie, and cross-origin requests are refused on the
upgrade. Tests get a token from `startTestServer` and present it through
`connect()`; the Playwright suite starts logged in via a cookie in its
storage state. Keep new routes behind `requireAuth`, new message fields
under a size cap in `SHAPES`, and read SECURITY.md before changing any of
it. If the user is locked out of Foray (lost token, logged out
everywhere), walk them through RECOVERY.md: it is written to be followed
from a laptop with SSH to the server.

## Build & check

- `npm run build` — typecheck (both client and server tsconfigs) then vite build
- `npm run typecheck` — typecheck only, no build
- `npm run test` — unit tests via `tsx --test` (node test runner, not jest)
- `npx tsx --test <file>` — one suite, e.g. `npx tsx --test src/__tests__/mobile.test.ts`

## Mobile architecture

The app detects touch devices via `IS_TOUCH` in `src/mobile.ts` (the `pointer: coarse` media query). Key differences on mobile:

- **Composer** (`Composer.tsx`) is mobile-only. It's a textarea input bar that pastes finished text into the terminal, avoiding IME ghost characters from typing directly into xterm.
- **Keyboard is a curtain.** The soft keyboard shrinks the visual viewport; `useAppHeight` sets `--app-height` from it so the layout ends where the keyboard begins, the pty is not resized, and the Composer dims while xterm has focus (`[data-main-column]:has(.xterm.focus)` in `styles.css`). Nothing is hidden when the keyboard is up.
- **Fixed-size pty.** Mobile terminals use a fixed pty size rather than resizing with the viewport.
- Tapping the terminal directly still works for quick y/n input.
