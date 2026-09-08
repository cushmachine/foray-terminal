# Deploying Nest

## On the VM

```bash
cd ~/nest
git pull
npm install
npm run typecheck
npm run deploy
```

`npm run deploy` runs `scripts/deploy.sh`: it restarts nest under pm2, or
starts it if it is not running, and relaunches it from
`ecosystem.config.cjs` when that file changed. pm2 runs `scripts/start.sh`,
which builds the client before starting the server, so a restart is a
deploy.

## Expose via Tailscale

```bash
tailscale serve --bg 3000
```

Then access at `http://foray:3000` or `https://foray.tail<hash>.ts.net` from any Tailscale-connected device.
