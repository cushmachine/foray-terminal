#!/usr/bin/env bash
# Keep nest sessions out of pm2's cgroup. Run by scripts/start.sh on every
# deploy; safe to run by hand. Idempotent. It only ever starts the unit;
# stopping or restarting it kills every session, so nothing here does that.
#
# 1. Install scripts/systemd/nest-tmux.service (plus the pm2 OOM drop-in and
#    the needrestart exclusion) when the copy under /etc differs, then
#    start/enable the unit.
# 2. If a tmux server is running outside that unit (e.g. one the nest app
#    spawned under pm2 before the unit existed), move it and all of its
#    descendants into the unit's cgroup. cgroup v2 lets root re-home live
#    processes, so no session is disturbed.

set -u
cd "$(dirname "$0")/.."

UNIT=nest-tmux.service
CGROUP=/sys/fs/cgroup/system.slice/$UNIT

install_if_changed() {
  local src="$1" dst="$2"
  if ! cmp -s "$src" "$dst"; then
    install -D -m 644 "$src" "$dst" && echo "[tmux-unit] installed $dst"
    return 0
  fi
  return 1
}

changed=0
install_if_changed scripts/systemd/nest-tmux.service "/etc/systemd/system/$UNIT" && changed=1
install_if_changed scripts/systemd/pm2-root-override.conf \
  /etc/systemd/system/pm2-root.service.d/override.conf && changed=1
# needrestart (run by unattended-upgrades) must never restart the unit.
install_if_changed scripts/systemd/needrestart-nest-tmux.conf \
  /etc/needrestart/conf.d/nest-tmux.conf
if [ "$changed" = 1 ]; then
  systemctl daemon-reload
  systemctl enable "$UNIT" >/dev/null 2>&1
fi
systemctl start "$UNIT" || { echo "[tmux-unit] could not start $UNIT" >&2; exit 1; }
# Type=simple returns before the server has its socket; give it a moment.
for _ in 1 2 3 4 5 6 7 8 9 10; do
  tmux display-message -p '#{pid}' >/dev/null 2>&1 && break
  sleep 0.3
done

# Adopt a server that is running somewhere else.
server_pid=$(tmux display-message -p '#{pid}' 2>/dev/null || true)
[ -n "$server_pid" ] || exit 0
current=$(cut -d: -f3 /proc/"$server_pid"/cgroup 2>/dev/null || true)
[ "$current" != "/system.slice/$UNIT" ] || exit 0

descendants() {
  local pid
  for pid in $(pgrep -P "$1"); do
    echo "$pid"
    descendants "$pid"
  done
}
moved=0
for pid in "$server_pid" $(descendants "$server_pid"); do
  if echo "$pid" > "$CGROUP/cgroup.procs" 2>/dev/null; then moved=$((moved + 1)); fi
done
echo "[tmux-unit] adopted tmux server $server_pid from $current ($moved processes)"
