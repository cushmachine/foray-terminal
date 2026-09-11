#!/usr/bin/env bash
# Keep Foray sessions out of pm2's cgroup. Run by scripts/start.sh on every
# deploy; safe to run by hand. Idempotent. It only ever starts the unit;
# stopping or restarting it kills every session, so nothing here does that.
#
# 1. Generate foray-tmux.service for this account and checkout (User=,
#    HOME=, WorkingDirectory=, ExecStart= and the node PATH filled in from
#    the environment actually running this script — the same live-heredoc
#    idiom install.sh uses for the macOS LaunchAgent, not a separate
#    template file), plus the pm2 OOM drop-in and the needrestart
#    exclusion, when the rendered content differs from what's installed,
#    then start/enable the unit.
# 2. If a tmux server is running on Foray's socket outside that unit (e.g.
#    one Foray spawned under pm2 before the unit existed), move it and all
#    of its descendants into the unit's cgroup. cgroup v2 lets root re-home
#    live processes, so no session is disturbed. This never looks at any
#    socket but Foray's own — a stranger's own tmux server is never touched.
#
# On a box that still runs the legacy nest-tmux.service on the machine's
# default tmux socket, this script does nothing at all: see the guard below.

set -u
cd "$(dirname "$0")/.."

# Resolve the socket exactly the way the server does (tmuxSocketArgs in
# src/server/tmux.ts): unset means Foray's own socket, "foray"; an explicit
# empty value means the machine's default socket. The two MUST agree. If
# this script skips on a value the server treats as "foray", the server
# still spawns a tmux server on that socket — as a child of itself, inside
# pm2's cgroup, with no unit around it — which is the OOM exposure of
# 2026-09-08 recreated in silence, and exiting 0 means scripts/start.sh
# reports success and warns nobody.
SOCKET="${FORAY_TMUX_SOCKET-foray}"
SOCK=()
[ -n "$SOCKET" ] && SOCK=(-L "$SOCKET")
# Baked into the unit's own Environment=, below, so tmux-server.sh and the
# unit's ExecStop agree on the same socket across reboots, not just for the
# process that happened to install it.
SOCKET_FLAG=""
[ -n "$SOCKET" ] && SOCKET_FLAG="-L $SOCKET "

# --- leave a pre-rename box alone -------------------------------------
# An empty socket means this box deliberately stays on the machine's
# default tmux socket, because it has Foray sessions from before Foray had
# its own and sessions cannot move between tmux servers
# (docs/plans/foray-tmux-socket.md item 6). Those sessions are already held
# by the old unit, so there is nothing here to install and nothing to
# adopt: do nothing at all.
#
# Note this tests $SOCKET, not whether FORAY_TMUX_SOCKET is set. Installing
# the unit for socket "foray" on such a box is harmless — it is a different
# tmux server from the one holding the old sessions, and the adoption walk
# below never looks at any socket but this one — and it is what keeps the
# server's own new sessions inside a unit instead of inside pm2.
if [ -z "$SOCKET" ] && systemctl cat nest-tmux.service >/dev/null 2>&1; then
  echo "[tmux-unit] FORAY_TMUX_SOCKET is empty and nest-tmux.service is installed:"
  echo "[tmux-unit] this box keeps its sessions on the default socket, in the old"
  echo "[tmux-unit] unit. Nothing to do. Remove that setting once every one of them"
  echo "[tmux-unit] has been closed or resumed."
  exit 0
fi

UNIT=foray-tmux.service
CGROUP=/sys/fs/cgroup/system.slice/$UNIT

# Writing the unit file and driving systemd both need root. As root, run
# them directly; as anyone else (the dedicated `foray` user SECURITY.md
# recommends, say), try sudo non-interactively only — a password prompt
# here would just hang scripts/start.sh, which runs this unattended on
# every deploy. When even -n sudo is not available, fail loudly with the
# exact command to run once by hand rather than limping on: a swallowed
# failure here is exactly how sessions end up back in pm2's cgroup (see
# scripts/start.sh, which wraps the call to this script).
SUDO=()
if [ "$(id -u)" -ne 0 ]; then
  if sudo -n true >/dev/null 2>&1; then
    SUDO=(sudo -n)
  else
    echo "[tmux-unit] not root, and passwordless sudo (sudo -n) is not available." >&2
    echo "[tmux-unit] Cannot install or start $UNIT, so sessions cannot move out of" >&2
    echo "[tmux-unit] pm2's cgroup. Run this once, by hand, as a user that can sudo:" >&2
    echo "[tmux-unit]" >&2
    echo "[tmux-unit]   sudo bash $(pwd)/scripts/ensure-tmux-unit.sh" >&2
    echo "[tmux-unit]" >&2
    echo "[tmux-unit] or grant this account passwordless sudo for 'install' and" >&2
    echo "[tmux-unit] 'systemctl daemon-reload|enable|start' on $UNIT (see" >&2
    echo "[tmux-unit] SECURITY.md's Recommended deployment, item 1)." >&2
    exit 1
  fi
fi

install_if_changed() {
  local src="$1" dst="$2"
  if ! cmp -s "$src" "$dst"; then
    "${SUDO[@]}" install -D -m 644 "$src" "$dst" && echo "[tmux-unit] installed $dst"
    return 0
  fi
  return 1
}

# Same idiom as the macOS LaunchAgent plist in install.sh: an unquoted
# heredoc that interpolates $VAR and $(cmd) live, rather than a static file
# plus sed substitution.
render_unit() {
  local node_bin here
  node_bin="$(dirname "$(command -v node)")"
  here="$(pwd)"
  cat <<UNIT
# $UNIT — generated by scripts/ensure-tmux-unit.sh, do not edit by hand.
#
# The tmux server that holds every Foray session, as its own systemd unit.
#
# Without this the server is spawned by Foray under pm2, so it lives in
# pm2's cgroup: a pm2 stop, or systemd tearing pm2 down after one of its
# processes is OOM-killed (2026-09-08: a Playwright Chrome), kills every
# session at once.
#
# scripts/tmux-server.sh runs the server in the foreground (\`tmux -D\`), so
# the unit has a live main process and its cgroup persists. A bare
# \`tmux start-server\` would daemonize and the oneshot cgroup would vanish.

[Unit]
Description=tmux server for Foray sessions
After=network.target
# Stopping or restarting kills every session. Refuse \`systemctl stop/restart\`
# (needrestart after an apt upgrade did that on 2026-09-09 06:10, and a
# session testing this setting did it again at 06:48 while the key sat in
# [Service], where systemd ignores it). Only a system shutdown may stop it.
# To really restart: remove this line, daemon-reload, restart, restore it.
RefuseManualStop=yes

[Service]
Type=simple
Restart=always
RestartSec=1
User=$(whoami)
Group=$(id -gn)
Environment=HOME=$HOME
Environment=SHELL=/bin/bash
Environment=LANG=en_US.UTF-8
Environment=PATH=$node_bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
Environment=FORAY_TMUX_SOCKET=$SOCKET
WorkingDirectory=$here
ExecStart=$here/scripts/tmux-server.sh
ExecStop=/usr/bin/tmux ${SOCKET_FLAG}kill-server
# One session's OOM-killed child must never stop this unit.
OOMPolicy=continue
# Prefer killing Foray/pm2 over a Claude session when memory runs out.
OOMScoreAdjust=-200
KillMode=control-group
LimitNOFILE=infinity
LimitNPROC=infinity

[Install]
WantedBy=multi-user.target
UNIT
}

tmp=$(mktemp)
trap 'rm -f "$tmp"' EXIT
render_unit > "$tmp"

changed=0
install_if_changed "$tmp" "/etc/systemd/system/$UNIT" && changed=1
install_if_changed scripts/systemd/pm2-oom-override.conf \
  "/etc/systemd/system/pm2-$(whoami).service.d/override.conf" && changed=1
# needrestart (run by unattended-upgrades) must never restart the unit.
install_if_changed scripts/systemd/needrestart-foray-tmux.conf \
  /etc/needrestart/conf.d/foray-tmux.conf
if [ "$changed" = 1 ]; then
  "${SUDO[@]}" systemctl daemon-reload
  "${SUDO[@]}" systemctl enable "$UNIT" >/dev/null 2>&1
fi
"${SUDO[@]}" systemctl start "$UNIT" || { echo "[tmux-unit] could not start $UNIT" >&2; exit 1; }
# Type=simple returns before the server has its socket; give it a moment.
for _ in 1 2 3 4 5 6 7 8 9 10; do
  tmux "${SOCK[@]}" display-message -p '#{pid}' >/dev/null 2>&1 && break
  sleep 0.3
done

# Adopt a server that is running somewhere else — but only on Foray's own
# socket. The default socket may belong to someone else's tmux entirely and
# is never touched here.
#
# When SOCKET is empty, SOCK is empty too, and every "${SOCK[@]}" tmux call
# above and below runs against the *default* socket, not a Foray-owned one
# — there is no such thing as "Foray's own socket" to adopt in that case.
# The guard at the top of this file already refuses to reach here while
# nest-tmux.service is installed, but that is not the only way the socket
# can end up empty (e.g. mid-cutover, after the legacy unit has been
# deleted by hand but before ecosystem.local.cjs has been), so check again,
# directly, right before the one block that can move live processes.
# Without this, an empty socket would make the walk below find whatever
# tmux server already happens to be on the machine's default socket —
# someone else's, or the box's own pre-rename sessions — and move it into
# foray-tmux.service, whose ExecStop is a bare `tmux kill-server`.
if [ ${#SOCK[@]} -eq 0 ]; then
  echo "[tmux-unit] FORAY_TMUX_SOCKET is empty: there is no Foray-owned socket to"
  echo "[tmux-unit] adopt a server from, so skipping the adoption walk."
  exit 0
fi

server_pid=$(tmux "${SOCK[@]}" display-message -p '#{pid}' 2>/dev/null || true)
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
  if "${SUDO[@]}" bash -c "echo '$pid' > '$CGROUP/cgroup.procs'" 2>/dev/null; then
    moved=$((moved + 1))
  fi
done
echo "[tmux-unit] adopted tmux server $server_pid from $current ($moved processes)"
