# Deploying Foray

Foray runs straight from the checkout: pm2 runs `scripts/start.sh`, which
builds the client with vite and starts the server with tsx. So the dev
dependencies (vite, tsx, typescript) are needed at runtime; install with
`npm install`, never `--omit=dev`.

## First install

```bash
git clone https://github.com/cushmachine/foray-terminal.git ~/foray
cd ~/foray && bash install.sh
```

`install.sh` installs tmux, Node 24 and pm2, runs `npm run deploy`, and
registers pm2 to start at boot. Foray ships its own tmux config
(`scripts/foray.tmux.conf`), applied only to its own server on its own
socket (see "Sessions live in foray-tmux.service" in CLAUDE.md) — it never
writes or edits `~/.tmux.conf`.

## Installed from npm

```bash
npx foray-terminal setup
```

`npx foray-terminal setup` runs the package's `bin/foray.mjs`. It copies
the package's own files — the built client included — into `~/foray` (or
`$FORAY_DIR`) when nothing is installed there yet, then runs the very same
`install.sh` as "First install" above against that directory. Nothing is
cloned: the package already carries everything, which is what makes this
work on a box with no git, and on a release you have in hand. If that
directory already holds an install, `setup` leaves it alone and says so
rather than writing over it. `install.sh` prints which path it is on
("Running as `foray setup`..." vs "Running from a git checkout...") so you
can always tell. It finishes the same way either path: your access token
printed once, and the Tailscale step if it could not run that for you.

`setup` finishes by installing the CLI itself globally too, best effort, so
two more commands are on your PATH after that:

```bash
foray token   # print the access token again, any time
foray update  # pull the latest release and redeploy
```

That install packs the running copy of the package into a tarball and
installs *that* (`npm pack` then `npm i -g` the result), rather than
`npm i -g` on the running copy's own directory. The directory can be npx's
own ephemeral cache, and npm's docs say installing a plain folder from
outside your project symlinks to it instead of copying — a symlink into a
cache directory with no promised lifetime, which would eventually leave
`foray` a dangling link. Packing first makes npm copy real files instead,
the same as installing a published release would.

(if that install didn't take — no global npm prefix, offline, whatever —
`npx foray-terminal token` / `npx foray-terminal update` do the same
thing).

`foray update` acts on `$FORAY_DIR` (default `~/foray`), and its two paths
handle local changes differently — one refuses to discard them, the other
has no way to know they're there. Inside a git checkout, it refuses:
`git status --porcelain` must come back clean, or it stops and prints what
it found, before running
`git pull --ff-only && npm install && npm run deploy`. If that directory is
not a git checkout — the npm install path — there is no working tree to
check, so nothing is refused. It first verifies the release is actually
usable: packs `foray-terminal@latest` and checks the tarball itself has a
`bin/foray.mjs` and a built `dist/` before anything touches the global
install (the registry has served a placeholder with no CLI under this name
before, and this must never trade a working `foray` for one that isn't).
Once verified, it installs from that exact tarball, resolves where that
put the new files (`npm root -g`, not wherever this invocation itself
happened to run from — `npx` in particular runs from its own ephemeral
cache, which never updates itself mid-command), and re-execs the freshly
installed CLI to refresh `$FORAY_DIR` from it. That refresh copies the new
package's files over the old ones **unconditionally** — any other file you
have hand-edited under `$FORAY_DIR` on this path is overwritten — except
it leaves an existing `ecosystem.config.cjs` alone, since that's the file
"Network and access" below tells you to edit for `HOST`. Put `$FORAY_DIR`
under git yourself (even without pushing it anywhere) if you want update
to protect more than that one file.

There is also `foray start`: the server in the foreground, no pm2 and no
build, run from the checkout at `$FORAY_DIR` — for Docker or local dev
against an already-built `dist/`. It needs that directory's own
`node_modules` (Foray runs its TypeScript server through `tsx`, a dev
dependency), which `install.sh` puts there; a bare `npm i -g
foray-terminal` installs production dependencies only, so `start` before a
`setup` tells you exactly which path is missing. The normal path here is
`setup`, not `start`.

## macOS as the server

The same installer works on a Mac (a MacBook or Mac mini at home, reached
over Tailscale). Differences from Linux:

- Run it as your normal user, never root. Sessions must run as the user
  who logged the agent in: Claude Code, for one, keeps its credentials in
  that user's Keychain.
- It needs Homebrew and the Xcode command-line tools (for node-pty's
  native build). The installer asks for the tools if they are missing.
- Boot persistence is a per-user LaunchAgent,
  `~/Library/LaunchAgents/com.foray.pm2.plist`, which runs `pm2 resurrect`
  at login. Turn on automatic login so it fires after an unattended reboot.
- There is no tmux unit at all (Linux calls it `foray-tmux.service`).
  macOS has no cgroups, so the tmux server daemonizes out of
  pm2's reach by itself and survives `npm run deploy`.
- Sleep kills the tailnet link. `sudo pmset -c sleep 0` keeps the Mac awake
  on power; a closed MacBook lid still sleeps unless it has power and an
  external display, or `sudo pmset -a disablesleep 1`.
- The Tailscale CLI is inside the app bundle:
  `/Applications/Tailscale.app/Contents/MacOS/Tailscale`.

## Updating

```bash
cd ~/foray
git pull
npm install
npm run deploy
```

`npm run deploy` runs `scripts/deploy.sh`: it typechecks first and stops
before touching pm2 if that fails, then restarts Foray under pm2 (starting
it if it is not running, or relaunching it from `ecosystem.config.cjs` when
that file changed). pm2 runs `scripts/start.sh`, which builds the client
before starting the server, so a restart is a deploy; a broken client
build keeps the previous `dist/` serving. Never run `pm2 restart` or
`pm2 start` by hand.

### When the page and the server disagree

Foray stamps the server with the commit it started from and the page with
the build it came from, and says so at the top of the app when the two
differ. That strip always carries a button: **reload** when the browser is
only holding an old page, and **sync now** when the server itself is
behind. *sync now* opens a session called `deploy` and runs
`npm run deploy` in it, so you can watch the build and answer anything it
asks; the deploy restarts the server and this page reconnects on its own.
Press it again while one is running and it just shows you the deploy
already going — the session is the lock, and two builds at once is how a
small box runs out of memory.

They drift apart when something builds without deploying, so nothing but a
deploy builds: `npm pack` and `npm publish` ship the `dist/` that is
already there rather than making a new one, and stop with a message if it
was not built from the checkout being packed. Deploy first, then pack.

## Network and access

Foray binds `127.0.0.1:3000` by default (`ecosystem.config.cjs`; `HOST`
picks the address, `PORT` the port — widen `HOST` only if you're fronting
it with your own proxy or firewall instead of Tailscale). Every socket and
upload requires the access token, which the server writes to
`~/.foray/token` on its first start. Print it with:

```bash
npm run token
```

The browser asks for it once per device and keeps a cookie for 30 days
of use. To log every device out, replace the file and redeploy:

```bash
(umask 077; openssl rand -base64 32 > ~/.foray/token) && npm run deploy
```

The `umask 077` is why that runs in a subshell: a plain `>` creates the
file at whatever umask your shell has, which on most systems leaves it
readable by every other account on the machine. The server creates its own
token file owner-only, and tightens the mode when it reads one back, but
that is a repair after the fact — the token is only as private as the
moment you wrote it.

Because Foray only listens on loopback, Tailscale HTTPS is the way in;
`install.sh` runs this for you when it can, or prints it:

```bash
tailscale serve --bg 3000
```

Then open `https://<server>.<tailnet>.ts.net` from any device on the
tailnet. SECURITY.md has the full picture and the rest of the recommended
hardening: a dedicated user and `FORAY_ALLOWED_HOSTS` pinned to your host
names.
