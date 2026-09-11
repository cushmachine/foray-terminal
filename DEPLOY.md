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

Two more commands come from the package's `bin/`:

```bash
foray token   # print the access token again, any time
foray update  # pull the latest release and redeploy
```

`foray update` acts on `$FORAY_DIR` (default `~/foray`) and never discards
local changes. Inside a git checkout it runs
`git pull --ff-only && npm install && npm run deploy`. If that directory is
not a git checkout — the npm install path — it reinstalls the package
(`npm i -g foray-terminal@latest`) and refreshes the directory from the new
copy. Either way a dirty checkout stops it: it prints what it found rather
than resetting anything.

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
openssl rand -base64 32 > ~/.foray/token && npm run deploy
```

Because Foray only listens on loopback, Tailscale HTTPS is the way in;
`install.sh` runs this for you when it can, or prints it:

```bash
tailscale serve --bg 3000
```

Then open `https://<server>.<tailnet>.ts.net` from any device on the
tailnet. SECURITY.md has the full picture and the rest of the recommended
hardening: a dedicated user and `FORAY_ALLOWED_HOSTS` pinned to your host
names.
