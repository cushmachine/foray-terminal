# Plan: give Foray its own tmux server

Paste this to a Claude Code session in the repo: "Read
docs/plans/foray-tmux-socket.md and build it."

## Why

Foray uses the machine's default tmux server. That means:

- On Linux, `scripts/ensure-tmux-unit.sh` finds whatever tmux server is
  running on the default socket and moves it, and every session in it,
  into Foray's root-owned systemd unit. A user who already uses tmux for
  their own work gets their sessions adopted without asking.
- `install.sh` edits the user's `~/.tmux.conf` (mouse off, history
  limit, extended keys), which changes every tmux they run.
- `tmux ls` in a user's own terminal shows Foray's `nest_*` sessions
  mixed with theirs.

tmux supports any number of servers on one machine; each is a separate
socket, chosen with `tmux -L <name>` (or `-S <path>`). Foray should run
on its own socket, with its own config file, and never touch the
default one.

## What to build

1. **One place that spells the socket.** Add `src/server/tmuxSocket.ts`
   (or a constant in `tmux.ts`) that reads `FORAY_TMUX_SOCKET`
   (default `foray`) and returns the argv prefix `['-L', name]`. Every
   tmux invocation goes through it: `tmux.ts` (`defaultExec`),
   `pty-bridge.ts` (`attach-session`), and the visual/e2e test helpers
   that call tmux directly (`src/visual/global-setup.ts`,
   `global-teardown.ts`, `src/e2e/*.ts` `killTmuxSession`). An empty
   value means the default socket, which is the migration path below.

2. **Foray's own config, applied by Foray.** Stop writing
   `~/.tmux.conf` in `install.sh`. Instead ship `scripts/foray.tmux.conf`
   with the four settings Foray needs and pass it with `-f` when the
   server is started (`tmux -L foray -f scripts/foray.tmux.conf -D` in
   `scripts/tmux-server.sh`; for the first `new-session` on macOS,
   where there is no unit, pass `-f` there too, since that call starts
   the server). `enableExtendedKeys` in `tmux.ts` already sets the
   server options at runtime and stays as the belt to this brace.

3. **The systemd unit runs the Foray socket.** `scripts/tmux-server.sh`
   uses `-L`. `ensure-tmux-unit.sh` must stop adopting foreign servers:
   it may adopt a server on the *Foray* socket that is outside the
   unit (a session created before the unit existed), never the default
   socket. `ExecStop` becomes `tmux -L foray kill-server`.

4. **Live-session markers.** `src/server/agents/claude.ts` reads the
   `tmux` field of `~/.claude/sessions/<pid>.json` (session:window.pane
   names). Those names are per server; check that `pastSessions.ts`
   resolving a live session's window still works when the window id
   comes from the Foray socket (it lists windows through `tmux.ts`, so it
   should follow automatically).

5. **The `TMUX` environment variable.** A shell inside a Foray session
   has `TMUX=/tmp/tmux-0/foray,pid,index`. Programs (Claude Code among
   them) use it to find their tmux; nothing to do, but verify the
   sidebar's title mirroring and the "live" markers still work end to
   end with a real session.

6. **Migration for a box already running sessions on the default
   socket** (the original server has several). Existing sessions cannot
   be moved between tmux servers. So: set `FORAY_TMUX_SOCKET: ''` in
   that box's `ecosystem.config.cjs` (keep the default socket) and leave
   a comment saying to remove it at a quiet moment, when every session
   has been closed or resumed; new installs get `foray`. Do not restart
   or stop `nest-tmux.service` (CLAUDE.md).

7. **Docs.** CLAUDE.md "Sessions live in nest-tmux.service", DEPLOY.md
   and SECURITY.md ("Existing tmux sessions") say the socket is Foray's
   own and how to look at it by hand: `tmux -L foray ls`.

8. **Tests.** The fake tmux in `src/server/__tests__/helpers.ts` records
   argv; assert every call starts with `-L foray` (or nothing when the
   socket is ''). The e2e suites run real tmux: point them at a
   throwaway socket (`FORAY_TMUX_SOCKET=foray-test`) so they never touch
   the box's live sessions, and kill that server in teardown.

## Do not

- Do not restart, stop, or reload `nest-tmux.service` on the original
  box; that kills every live session.
- Do not run two heavy jobs (build, deploy, Playwright) at once on the
  original box (3.8 GB, no swap).
- Do not `git add -A`; other sessions share this checkout.
