# Nest

## Deploy

Run `npm run deploy` to build and restart the app. It runs `scripts/deploy.sh`, which restarts nest under pm2, or relaunches it from `ecosystem.config.cjs` when that file changed (pm2 does not pick up a changed script or interpreter on a plain restart). pm2 runs `scripts/start.sh`, which builds the client and then starts the server, so every restart is a full deploy and the server and page stamps always match. The app prompts connected clients to reload via `VersionBanner`. Do not use the dev server — we deploy straight to prod. Never run `pm2 restart` or `pm2 start` by hand; use `npm run deploy`.

## Sessions live in nest-tmux.service

The tmux server that holds every session runs in its own systemd unit, `nest-tmux.service` (`scripts/systemd/`, installed by `scripts/ensure-tmux-unit.sh` from `start.sh`), not under pm2. So a deploy, a pm2 crash, or an OOM teardown of pm2 leaves sessions alive. Never `systemctl stop` or `restart nest-tmux`: that kills every session. To recover lost sessions, find their uuids in `~/.claude/activity.log` and run `claude --resume <uuid>` inside a new `nest_<name>` tmux session.

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
