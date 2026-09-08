# Deploying Nest

Nest runs straight from the checkout: pm2 runs `scripts/start.sh`, which
builds the client with vite and starts the server with tsx. So the dev
dependencies (vite, tsx, typescript) are needed at runtime; install with
`npm install`, never `--omit=dev`.

## First install

```bash
git clone https://github.com/cushmachine/nest.git ~/nest
cd ~/nest && bash install.sh
```

`install.sh` installs tmux, Node 24 and pm2, writes the tmux settings Nest
needs, runs `npm run deploy`, and registers pm2 with systemd so nest comes
back after a reboot.

## Updating

```bash
cd ~/nest
git pull
npm install
npm run deploy
```

`npm run deploy` runs `scripts/deploy.sh`: it typechecks first and stops
before touching pm2 if that fails, then restarts nest under pm2 (starting
it if it is not running, or relaunching it from `ecosystem.config.cjs` when
that file changed). pm2 runs `scripts/start.sh`, which builds the client
before starting the server, so a restart is a deploy; a broken client
build keeps the previous `dist/` serving. Never run `pm2 restart` or
`pm2 start` by hand.

## Network

Nest listens on port 3000 on every interface (`ecosystem.config.cjs`) and
has no authentication: it assumes a private network. Expose it over
Tailscale:

```bash
tailscale serve --bg 3000
```

Then open `http://foray:3000` or `https://foray.tail<hash>.ts.net` from any
device on the tailnet.
