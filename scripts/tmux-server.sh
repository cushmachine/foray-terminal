#!/usr/bin/env bash
# ExecStart of nest-tmux.service (see scripts/systemd/nest-tmux.service).
#
# Normally runs the tmux server in the foreground (`tmux -D`: no daemon,
# exit-empty off) so the unit owns it and its cgroup holds every session.
#
# If a server is already up on the default socket, one that the nest app
# spawned under pm2 before this unit existed, we cannot start a second one.
# Instead hold the unit open while that server lives, so its cgroup exists
# for scripts/ensure-tmux-unit.sh to adopt the server into. When the old
# server finally exits, this script exits too and systemd restarts the unit,
# which then starts a fresh foreground server.

set -u
pid=$(tmux display-message -p '#{pid}' 2>/dev/null || true)
if [ -z "$pid" ]; then
  exec tmux -D
fi
echo "[tmux-server] server $pid already running; holding the unit for it"
tmux set -s exit-empty off
while kill -0 "$pid" 2>/dev/null; do sleep 15; done
echo "[tmux-server] server $pid exited"
