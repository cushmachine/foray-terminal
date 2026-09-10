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

`install.sh` installs tmux, Node 24 and pm2, writes the tmux settings Foray
needs, runs `npm run deploy`, and registers pm2 to start at boot.

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
- There is no `nest-tmux.service`. macOS has no cgroups, so the tmux server
  daemonizes out of pm2's reach by itself and survives `npm run deploy`.
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

## Network

Foray listens on port 3000 on every interface (`ecosystem.config.cjs`) and
has no authentication: it assumes a private network. Set `HOST` to bind
one interface instead (`HOST=127.0.0.1` keeps it local; `PORT` picks the
port). Expose it over Tailscale:

```bash
tailscale serve --bg 3000
```

Then open `http://<server>:3000` or `https://<server>.tail<hash>.ts.net` from any
device on the tailnet.
