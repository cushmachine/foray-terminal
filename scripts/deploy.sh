#!/usr/bin/env bash
# Deploy Foray: typecheck, then restart it under pm2, applying
# ecosystem.config.cjs if that changed. This is what `npm run deploy` runs.
#
# The typecheck comes first because scripts/start.sh builds with vite alone
# (no tsc) and would happily serve a bundle the types reject; failing here
# leaves the running app untouched.
#
# pm2 re-reads only some options from the config on a restart (log format,
# env) and silently keeps others (script, interpreter), so when the config
# is newer than the running process the app is deleted and started fresh
# from the file. In fork mode both paths are a stop and a start, so the
# downtime is the same. The build happens inside scripts/start.sh.

set -eu
cd "$(dirname "$0")/.."

APP=foray
LEGACY_APP=nest
CONFIG=ecosystem.config.cjs

if ! command -v pm2 >/dev/null 2>&1; then
  echo "[deploy] pm2 is not installed; run install.sh or 'npm install -g pm2'" >&2
  exit 1
fi

echo "[deploy] typechecking"
npm run typecheck

# pm2 jlist prints nothing useful when the daemon is not up yet; treat any
# unparsable output as "not running" rather than aborting. One call covers
# both apps so checking for the pre-rename one below costs nothing extra.
jlist=$(pm2 jlist 2>/dev/null || true)
set -- $(printf '%s' "$jlist" | node -e '
  let apps = []
  try { apps = JSON.parse(require("fs").readFileSync(0, "utf8")) } catch {}
  const uptime = (name) => {
    const app = apps.find((a) => a.name === name)
    return app ? app.pm2_env.pm_uptime : 0
  }
  console.log(uptime(process.argv[1]), uptime(process.argv[2]))
' "$APP" "$LEGACY_APP")
started_ms=${1:-0}
legacy_ms=${2:-0}
# GNU stat (Linux) and BSD stat (macOS) spell "mtime in seconds" differently.
mtime() { stat -c %Y "$1" 2>/dev/null || stat -f %m "$1"; }
config_ms=$(( $(mtime "$CONFIG") * 1000 ))

if [ "$started_ms" -eq 0 ]; then
  # The pre-rename app is still up on this port: starting a second app
  # would fail to bind, pm2 would restart-loop it, and `pm2 save` below
  # would write that crash loop into ~/.pm2/dump.pm2 — every future
  # `pm2 resurrect` (the boot path on both platforms) would then bring
  # back both apps forever. Stop before either happens.
  if [ "$legacy_ms" -gt 0 ]; then
    echo "[deploy] pm2 still runs the pre-rename app \"$LEGACY_APP\" on this port." >&2
    echo "[deploy] Cut over by hand, once: pm2 delete $LEGACY_APP && npm run deploy" >&2
    exit 1
  fi
  echo "[deploy] $APP is not running; starting it from $CONFIG"
  pm2 start "$CONFIG"
elif [ "$config_ms" -gt "$started_ms" ]; then
  echo "[deploy] $CONFIG changed since $APP started; relaunching from it"
  pm2 delete "$APP"
  pm2 start "$CONFIG"
else
  pm2 restart "$APP"
fi
pm2 save
