#!/usr/bin/env bash
# Deploy nest: restart it under pm2, applying ecosystem.config.cjs if that
# changed. This is what `npm run deploy` runs.
#
# pm2 re-reads only some options from the config on a restart (log format,
# env) and silently keeps others (script, interpreter), so when the config
# is newer than the running process the app is deleted and started fresh
# from the file. In fork mode both paths are a stop and a start, so the
# downtime is the same. The build happens inside scripts/start.sh.

set -eu
cd "$(dirname "$0")/.."

APP=nest
CONFIG=ecosystem.config.cjs

started_ms=$(pm2 jlist 2>/dev/null | node -e '
  const apps = JSON.parse(require("fs").readFileSync(0, "utf8"))
  const app = apps.find((a) => a.name === process.argv[1])
  console.log(app ? app.pm2_env.pm_uptime : 0)
' "$APP")
config_ms=$(( $(stat -c %Y "$CONFIG") * 1000 ))

if [ "$started_ms" -eq 0 ]; then
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
