#!/usr/bin/env bash
# Foray installer — run on a fresh Ubuntu VPS (22.04+) or a Mac that will
# act as the server (a MacBook or Mac mini at home, reached over Tailscale).
#
# This script has two callers, and does the same thing for both:
#   - a contributor, running it by hand from a git clone (Usage below);
#   - `foray setup`, from the foray-terminal npm package. It copies the
#     package's own files (the built client included) into FORAY_DIR when
#     nothing is installed there, then execs this file with FORAY_DIR
#     pinned to that directory — so the clone step below is never reached
#     on that path. Nothing needs git, and nothing is fetched: the package
#     already carries everything.
# It prints which one it thinks it is (see "running from" below) so a
# reader watching the output knows which path they are on.
#
# What it does:
#   1. Installs system deps (tmux, build tools for node-pty): apt on
#      Linux, Homebrew plus the Xcode command-line tools on macOS
#   2. Installs Node.js 24 via nvm, but only when Node is missing or older
#      than that (package.json's engines says ">=24", so newer is fine)
#   3. Uses whatever is already in FORAY_DIR, or clones the repo there
#   4. Runs npm install (dev deps included: prod runs with tsx and vite)
#   5. Checks for Tailscale — refuses to continue without it unless told
#      otherwise — and turns on `tailscale serve` when it can
#   6. Installs pm2, deploys Foray under it (npm run deploy), and registers
#      pm2 to start at boot: with systemd on Linux, with a per-user
#      LaunchAgent on macOS (so it runs inside the logged-in user's session,
#      where the agent's Keychain login lives)
#
# Usage (contributors, from a clone):
#   git clone https://github.com/cushmachine/foray-terminal.git ~/foray
#   cd ~/foray && bash install.sh
#
# Usage (everyone else, from npm — runs this same script for you):
#   npx foray-terminal setup
#
# Environment variables:
#   FORAY_DIR   — where to install. Defaults to the checkout running this
#                 script when it's a git checkout (the contributor path
#                 above), otherwise ~/foray (the npm path).
#   FORAY_SKIP_SERVICE — set to 1 to skip pm2 and the boot service (for Docker)
#   FORAY_ALLOW_NO_TAILSCALE — set to 1 to install without Tailscale present
#   FORAY_ALLOW_ROOT — set to 1 to install as root with no terminal to confirm
#
# The port is 3000, set in ecosystem.config.cjs; Foray binds it to 127.0.0.1
# only, so Tailscale (or your own HTTPS proxy) is what makes it reachable.

set -euo pipefail

FORAY_PORT=3000
NODE_MAJOR="24"

info()  { printf '\033[1;32m→\033[0m %s\n' "$*"; }
warn()  { printf '\033[1;33m!\033[0m %s\n' "$*"; }
die()   { printf '\033[1;31m✗\033[0m %s\n' "$@" >&2; exit 1; }

# A git checkout has a .git entry next to this script; the npm package
# never does (npm does not ship it), so this tells the two callers above
# apart without needing anything passed in from foray setup. `.git` is a
# directory in a normal clone but a plain file (pointing at the real one)
# in a git worktree, so this checks existence with -e, not -d: a -d check
# misreads a worktree as the npm path and clones a second checkout next to
# it — the exact bug FORAY_DIR's default just below exists to prevent.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -e "$SCRIPT_DIR/.git" ]; then
  info "Running from a git checkout at $SCRIPT_DIR (contributor path)."
  # Default FORAY_DIR to the checkout that's actually running this script,
  # not $HOME/foray. Without this, `git clone ... ~/src/foray && cd
  # ~/src/foray && bash install.sh` clones the repo a *second* time into
  # ~/foray and installs/deploys that copy, while the contributor goes on
  # editing ~/src/foray — every change they make is invisible to the
  # running app. `foray setup` is unaffected: it always passes FORAY_DIR
  # explicitly (see bin/foray.mjs), which wins over this default either way.
  FORAY_DIR="${FORAY_DIR:-$SCRIPT_DIR}"
else
  info "Running as \`foray setup\`, from the installed npm package."
  FORAY_DIR="${FORAY_DIR:-$HOME/foray}"
fi

# ---------- preflight ----------

OS="$(uname)"
case "$OS" in
  Linux|Darwin) ;;
  *) die "Foray runs on Linux or macOS. This is $OS." ;;
esac

SUDO=""
if [ "$OS" = Darwin ]; then
  # Sessions must run as the person who logged the agent in. Claude Code,
  # for one, keeps its credentials in that user's Keychain, which root
  # cannot see.
  [ "$(id -u)" -ne 0 ] || die "On macOS, run install.sh as your normal user, not root."
elif [ "$(id -u)" -ne 0 ]; then
  warn "Not running as root. Some steps may need sudo."
  SUDO="sudo"
else
  warn "Running as root: every Foray session will be a root shell. A dedicated"
  warn "user is safer (see SECURITY.md's Recommended deployment section)."
  if [ -t 0 ]; then
    read -r -p "Continue as root anyway? Type 'yes' to proceed: " REPLY || REPLY=""
    [ "$REPLY" = yes ] || die "Aborted. Create a dedicated user and re-run install.sh as it."
  elif [ "${FORAY_ALLOW_ROOT:-0}" != "1" ]; then
    die "Running as root with no terminal to confirm." \
        "Re-run with FORAY_ALLOW_ROOT=1 to continue anyway, or as a dedicated user."
  else
    warn "Continuing as root (FORAY_ALLOW_ROOT=1)."
  fi
fi

# ---------- system deps ----------

if [ "$OS" = Darwin ]; then
  # node-pty compiles a native module, which needs the command-line tools.
  if ! xcode-select -p >/dev/null 2>&1; then
    xcode-select --install || true
    die "Installing the Xcode command-line tools; rerun install.sh when that finishes."
  fi
  # Homebrew is only needed for the deps that are actually missing, so ask
  # for it at the point of use rather than up front: a Mac that already has
  # tmux and python3 needs no Homebrew at all, and an old one whose Homebrew
  # no longer works ("no bottle available") can still install Foray.
  need_brew() {
    command -v brew >/dev/null 2>&1 || die "Homebrew is required on macOS: https://brew.sh"
  }
  # Ask whether tmux is on PATH, not whether Homebrew installed it: tmux from
  # MacPorts, a source build or a system package counts just as much, and
  # sending that machine down the Homebrew path turns a dependency that was
  # already satisfied into a failed install.
  if ! command -v tmux >/dev/null 2>&1; then
    need_brew
    info "Installing tmux via Homebrew..."
    brew list --versions tmux >/dev/null 2>&1 || brew install tmux
  fi
  # node-gyp shells out to python3 to build node-pty, the same way the apt
  # branch below installs it. Recent Xcode command-line tools carry a
  # python3; an older install may not, and when it is missing the failure
  # surfaces much later as an opaque node-gyp error in the middle of npm
  # install rather than as anything a reader could act on.
  if ! command -v python3 >/dev/null 2>&1; then
    need_brew
    info "Installing python3 via Homebrew (node-pty needs it to compile)..."
    brew list --versions python3 >/dev/null 2>&1 || brew install python3
  fi
else
  info "Installing system packages (tmux, build-essential, python3)..."
  if command -v apt-get >/dev/null 2>&1; then
    ${SUDO:+$SUDO} apt-get update -qq
    ${SUDO:+$SUDO} apt-get install -y -qq tmux build-essential python3 git curl >/dev/null
  else
    die "Only apt-based distros (Ubuntu/Debian) are supported on Linux."
  fi
fi

# ---------- Node.js via nvm ----------

export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"

if [ ! -s "$NVM_DIR/nvm.sh" ]; then
  info "Installing nvm..."
  curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
fi

# shellcheck source=/dev/null
. "$NVM_DIR/nvm.sh"

# NODE_MAJOR is a floor, not a target: package.json's engines says ">=24",
# so 25 and later are supported too. An exact-major test here would see the
# Node that README step 1's `brew install node` just installed, decide it is
# "wrong", and run `nvm alias default 24` — quietly moving someone's
# system-wide default Node *backwards* to satisfy a constraint that does not
# exist. Only install when Node is missing or genuinely too old.
CURRENT_NODE="$(node -v 2>/dev/null || echo "")"
CURRENT_MAJOR="${CURRENT_NODE#v}"      # v24.20.0 -> 24.20.0
CURRENT_MAJOR="${CURRENT_MAJOR%%.*}"   # 24.20.0  -> 24
case "$CURRENT_MAJOR" in
  # No node at all, or a version string we cannot read: treat it as too old
  # so the arithmetic test below never sees a non-number and aborts.
  '' | *[!0-9]*) CURRENT_MAJOR=0 ;;
esac
if [ "$CURRENT_MAJOR" -lt "$NODE_MAJOR" ]; then
  info "Installing Node.js ${NODE_MAJOR}..."
  nvm install "$NODE_MAJOR"
  nvm alias default "$NODE_MAJOR"
else
  info "Node.js ${CURRENT_NODE} is new enough (Foray needs ${NODE_MAJOR} or later)."
fi

# ---------- clone or detect repo ----------

if [ -f "$FORAY_DIR/package.json" ]; then
  info "Using the existing Foray install at $FORAY_DIR."
else
  info "Cloning Foray into $FORAY_DIR..."
  if ! git clone https://github.com/cushmachine/foray-terminal.git "$FORAY_DIR" 2>/dev/null; then
    die "Clone failed. If the repo is private, clone it manually first:" \
        "  git clone https://github.com/cushmachine/foray-terminal.git $FORAY_DIR" \
        "  cd $FORAY_DIR && bash install.sh"
  fi
fi

cd "$FORAY_DIR"

# ---------- npm install ----------

info "Installing npm dependencies (includes compiling node-pty)..."
npm install 2>&1 | tail -5

# Foray's tmux config lives in scripts/foray.tmux.conf (applied by
# scripts/tmux-server.sh) — nothing to do here; this never touches ~/.tmux.conf.

# ---------- Tailscale ----------

# `tailscale status --json | grep -q '"BackendState": *"Running"'` (the
# previous version of this check) is a SIGPIPE trap: under `set -o
# pipefail` (above), `grep -q` exits at its first match and closes its end
# of the pipe, so once `tailscale` has more to write than fits in one
# pipe buffer it gets SIGPIPE, exits 141, and pipefail makes the whole
# pipeline read as failure even though the state really is "Running". A
# one-peer tailnet's `tailscale status --json` is only a few KB and slips
# through; at roughly 2.4 KB per peer, 30-40 peers is enough to trigger
# it. Avoid the whole class of bug by never leaving the pipe with only one
# reader that can quit early: write the output to a file first (so nothing
# is still writing when it's read), then parse it as JSON rather than
# pattern-matching the text.
tailscale_running() {
  local status_file
  status_file="$(mktemp)"
  tailscale status --json >"$status_file" 2>/dev/null || true
  node -e '
    try {
      const st = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))
      process.exit(st.BackendState === "Running" ? 0 : 1)
    } catch {
      process.exit(1)
    }
  ' "$status_file"
  local result=$?
  rm -f "$status_file"
  return $result
}

# Check for Tailscale now, before Foray starts, not as a footnote after the
# fact. Skipped along with the rest of this section when
# FORAY_SKIP_SERVICE=1 — nothing is being exposed to reach in the first
# place.
if [ "${FORAY_SKIP_SERVICE:-0}" = "1" ]; then
  :
elif [ "$OS" = Linux ]; then
  if ! command -v tailscale >/dev/null 2>&1; then
    if [ "${FORAY_ALLOW_NO_TAILSCALE:-0}" != "1" ]; then
      die "No Tailscale binary found. Foray only listens on 127.0.0.1, so" \
          "without Tailscale (or your own HTTPS proxy already in place)" \
          "nothing but this machine can reach it: https://tailscale.com/download" \
          "To install anyway, rerun with FORAY_ALLOW_NO_TAILSCALE=1."
    fi
    warn "No Tailscale binary found; continuing (FORAY_ALLOW_NO_TAILSCALE=1)."
    warn "Foray will be reachable only from this machine until you set up"
    warn "Tailscale or another HTTPS proxy — see SECURITY.md."
  elif tailscale_running; then
    info "Exposing Foray over Tailscale HTTPS..."
    if tailscale serve --bg "$FORAY_PORT" >/dev/null 2>&1; then
      info "Done — run 'tailscale serve status' any time to see the URL."
    else
      warn "tailscale serve failed; run it yourself: tailscale serve --bg $FORAY_PORT"
    fi
  else
    warn "Tailscale is installed but not logged in. After 'tailscale up', run:"
    warn "  tailscale serve --bg $FORAY_PORT"
  fi
else
  # The macOS CLI is usually not on PATH (see the alias in the closing
  # steps below), so this stays print-only here even when a `tailscale`
  # binary happens to be found.
  warn "Foray binds 127.0.0.1. See the Tailscale step below to reach it from"
  warn "another device."
fi

# ---------- pm2 + boot service ----------

if [ "${FORAY_SKIP_SERVICE:-0}" = "1" ]; then
  info "Skipping pm2 and the boot service (FORAY_SKIP_SERVICE=1)."
  info "Start Foray yourself with: npm run deploy"
else
  if ! command -v pm2 >/dev/null 2>&1; then
    info "Installing pm2..."
    npm install -g pm2 2>&1 | tail -1
  fi

  # Typechecks, then starts Foray from ecosystem.config.cjs; pm2 runs
  # scripts/start.sh, which builds the client and starts the server.
  info "Deploying Foray under pm2..."
  npm run deploy

  if [ "$OS" = Darwin ]; then
    # `pm2 startup launchd` insists on sudo and then loads a per-user agent
    # from root's session, which leaves it half-registered. Write the agent
    # ourselves and load it as the user. It runs `pm2 resurrect` at login,
    # which restores whatever `pm2 save` recorded; the pm2 daemon then
    # lives on by itself. AbandonProcessGroup keeps launchd from killing
    # the tmux server's tree if the agent is ever unloaded.
    info "Registering a LaunchAgent so Foray starts at login..."
    AGENT_LABEL=com.foray.pm2
    AGENT_DIR="$HOME/Library/LaunchAgents"
    AGENT_PLIST="$AGENT_DIR/$AGENT_LABEL.plist"
    mkdir -p "$AGENT_DIR"
    cat > "$AGENT_PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$AGENT_LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$(command -v pm2)</string>
    <string>resurrect</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>AbandonProcessGroup</key><true/>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>$(dirname "$(command -v node)"):/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
    <key>HOME</key><string>$HOME</string>
  </dict>
  <key>StandardOutPath</key><string>$HOME/Library/Logs/foray-pm2.log</string>
  <key>StandardErrorPath</key><string>$HOME/Library/Logs/foray-pm2.log</string>
</dict>
</plist>
PLIST
    launchctl bootout "gui/$(id -u)/$AGENT_LABEL" >/dev/null 2>&1 || true
    launchctl bootstrap "gui/$(id -u)" "$AGENT_PLIST" \
      || warn "Could not load $AGENT_PLIST; Foray will not come back after a reboot."
  else
    # `pm2 startup` normally prints a root command for the user to paste;
    # run it directly. PATH is passed through so the unit finds this node.
    info "Registering pm2 with systemd..."
    ${SUDO:+$SUDO} env PATH="$PATH" "$(command -v pm2)" startup systemd -u "$(whoami)" --hp "$HOME" >/dev/null
  fi
  pm2 save >/dev/null

  if pm2 pid foray 2>/dev/null | grep -q '[1-9]'; then
    info "Foray is running on port $FORAY_PORT."
  else
    warn "Foray did not start. Check: pm2 logs foray"
  fi
fi

# ---------- access token ----------

# The server writes ~/.foray/token on its first start; give it a moment.
TOKEN=""
for _ in 1 2 3 4 5 6 7 8 9 10; do
  TOKEN="$(bash scripts/token.sh 2>/dev/null || true)"
  [ -n "$TOKEN" ] && break
  sleep 1
done

# ---------- done ----------

echo ""
info "Done! Next steps:"
echo ""
if [ -n "$TOKEN" ] && [ -t 1 ]; then
  echo "  Your access token (the browser asks for it once per device):"
  echo ""
  echo "       $TOKEN"
  echo ""
  echo "     Print it again any time with: npm run token"
  echo ""
else
  echo "  The access token is written to ~/.foray/token on the server's first"
  echo "  start; print it with: npm run token"
  echo ""
fi
if [ "$OS" = Darwin ]; then
  MAC_NAME="$(scutil --get LocalHostName 2>/dev/null | tr 'A-Z' 'a-z' || hostname)"
  echo "  1. Install Tailscale from the App Store or https://tailscale.com/download"
  echo "     and sign in. Its CLI lives inside the app bundle:"
  echo "       alias tailscale=/Applications/Tailscale.app/Contents/MacOS/Tailscale"
  echo ""
  echo "  2. Expose Foray over Tailscale HTTPS — Foray binds 127.0.0.1, not"
  echo "     the network, so this is the only way in (and how you install it"
  echo "     as a home-screen app on iPhone):"
  echo "       tailscale serve --bg ${FORAY_PORT}"
  echo "       Then open https://${MAC_NAME}.<your-tailnet>.ts.net"
  echo ""
  echo "  3. Keep the Mac awake and logged in, or sessions vanish with it:"
  echo "       sudo pmset -c sleep 0 disksleep 0     # never sleep on power"
  echo "     A closed lid still sleeps a MacBook unless it has power and an"
  echo "     external display, or you run: sudo pmset -a disablesleep 1"
  echo "     Turn on automatic login (System Settings > Users & Groups) so"
  echo "     Foray comes back after a reboot without someone at the keyboard."
  echo ""
else
  echo "  1. Install Tailscale (if not already):"
  echo "       curl -fsSL https://tailscale.com/install.sh | sh && tailscale up"
  echo ""
  echo "  2. Expose Foray over Tailscale HTTPS — Foray binds 127.0.0.1, not"
  echo "     the network, so this is the only way in (see SECURITY.md):"
  echo "       tailscale serve --bg ${FORAY_PORT}"
  echo "       Then open https://$(hostname).<your-tailnet>.ts.net"
  echo ""
fi
