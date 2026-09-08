# Deploying Nest

## On the VM

```bash
cd ~/nest
git pull
npm install
npm run typecheck
pm2 restart nest 2>/dev/null || (pm2 start ecosystem.config.cjs && pm2 save)
```

pm2 runs `scripts/start.sh`, which builds the client before starting the
server, so a restart is a deploy. If `ecosystem.config.cjs` changed, apply
it with `pm2 restart ecosystem.config.cjs --update-env && pm2 save`.

## Expose via Tailscale

```bash
tailscale serve --bg 3000
```

Then access at `http://foray:3000` or `https://foray.tail<hash>.ts.net` from any Tailscale-connected device.
