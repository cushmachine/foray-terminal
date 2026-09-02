# Deploying Nest

## On the VM

```bash
cd ~/nest
git pull
npm install
npm run build
pm2 restart nest 2>/dev/null || pm2 start ecosystem.config.cjs
```

## Expose via Tailscale

```bash
tailscale serve --bg 3000
```

Then access at `http://foray:3000` or `https://foray.tail<hash>.ts.net` from any Tailscale-connected device.
