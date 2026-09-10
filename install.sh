#!/usr/bin/env bash
# Foray installer — run on a fresh Ubuntu VPS (22.04+) or a Mac that will
# act as the server (a MacBook or Mac mini at home, reached over Tailscale).
#
# What it does:
#   1. Installs system deps (tmux, build tools for node-pty): apt on
#      Linux, Homebrew plus the Xcode command-line tools on macOS
#   2. Installs Node.js 24 via nvm
#   3. Clones the repo (or uses an existing checkout)
#   4. Runs npm install (dev deps included: prod runs with tsx and vite)
#   5. Writes the tmux config Foray expects
#   6. Installs pm2, deploys Foray under it (npm run deploy), and registers
#      pm2 to start at boot: with systemd on Linux, with a per-user
#      LaunchAgent on macOS (so it runs inside the logged-in user's session,
#      where the agent's Keychain login lives)
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/cushmachine/foray-terminal/main/install.sh | bash
#
# Or, if the repo is private:
#   git clone https://github.com/cushmachine/foray-terminal.git ~/foray
#   cd ~/foray && bash install.sh
#
# Environment variables:
#   NEST_DIR   — where to install (default: ~/foray)
#   NEST_SKIP_SERVICE — set to 1 to skip pm2 and the boot service (for Docker)
#
# The port is 3000, set in ecosystem.config.cjs.

set -euo pipefail

NEST_DIR="${NEST_DIR:-$HOME/foray}"
NEST_PORT=3000
NODE_MAJOR="24"

info()  { printf '\033[1;32m→\033[0m %s\n' "$*"; }
warn()  { printf '\033[1;33m!\033[0m %s\n' "$*"; }
die()   { printf '\033[1;31m✗\033[0m %s\n' "$@" >&2; exit 1; }

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
fi

# ---------- system deps ----------

if [ "$OS" = Darwin ]; then
  # node-pty compiles a native module, which needs the command-line tools.
  if ! xcode-select -p >/dev/null 2>&1; then
    xcode-select --install || true
    die "Installing the Xcode command-line tools; rerun install.sh when that finishes."
  fi
  command -v brew >/dev/null 2>&1 || die "Homebrew is required on macOS: https://brew.sh"
  info "Installing tmux via Homebrew..."
  brew list --versions tmux >/dev/null 2>&1 || brew install tmux
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

CURRENT_NODE="$(node -v 2>/dev/null || echo "")"
if [[ "$CURRENT_NODE" != v${NODE_MAJOR}.* ]]; then
  info "Installing Node.js ${NODE_MAJOR}..."
  nvm install "$NODE_MAJOR"
  nvm alias default "$NODE_MAJOR"
else
  info "Node.js ${CURRENT_NODE} already installed."
fi

# ---------- clone or detect repo ----------

if [ -f "$NEST_DIR/package.json" ]; then
  info "Using existing checkout at $NEST_DIR."
else
  info "Cloning Foray into $NEST_DIR..."
  if ! git clone https://github.com/cushmachine/foray-terminal.git "$NEST_DIR" 2>/dev/null; then
    die "Clone failed. If the repo is private, clone it manually first:" \
        "  git clone https://github.com/cushmachine/foray-terminal.git $NEST_DIR" \
        "  cd $NEST_DIR && bash install.sh"
  fi
fi

cd "$NEST_DIR"

# ---------- npm install ----------

info "Installing npm dependencies (includes compiling node-pty)..."
npm install 2>&1 | tail -5

# ---------- tmux config ----------

TMUX_CONF="$HOME/.tmux.conf"

# Check whether the settings Foray needs are already present, regardless
# of how they got there (hand-written, a previous install, etc.).
has_mouse_off=false
has_history_limit=false
has_extended_keys=false
has_extended_keys_format=false
if [ -f "$TMUX_CONF" ]; then
  grep -q 'set.*mouse off' "$TMUX_CONF" 2>/dev/null && has_mouse_off=true
  grep -q 'set.*history-limit' "$TMUX_CONF" 2>/dev/null && has_history_limit=true
  grep -q 'set.*extended-keys always' "$TMUX_CONF" 2>/dev/null && has_extended_keys=true
  grep -q 'set.*extended-keys-format csi-u' "$TMUX_CONF" 2>/dev/null && has_extended_keys_format=true
fi

if $has_mouse_off && $has_history_limit && $has_extended_keys && $has_extended_keys_format; then
  info "tmux config already has the settings Foray needs."
elif [ -f "$TMUX_CONF" ]; then
  warn "Existing ~/.tmux.conf found — appending Foray settings."
  {
    echo ""
    echo "# Added by Foray installer"
    $has_mouse_off  || echo "set -g mouse off"
    $has_history_limit || echo "set -g history-limit 10000"
    $has_extended_keys || echo "set -s extended-keys always"
    $has_extended_keys_format || echo "set -s extended-keys-format csi-u"
  } >> "$TMUX_CONF"
else
  info "Writing tmux config..."
  cat > "$TMUX_CONF" <<'TMUX'
# Foray: scrollback comes from tmux history, served as HTML to the browser.
set -g mouse off
set -g history-limit 10000
# Modified keys (Shift+Enter in Claude Code) reach the pane as CSI u instead
# of being downgraded to a plain Enter.
set -s extended-keys always
set -s extended-keys-format csi-u
TMUX
fi

# ---------- pm2 + boot service ----------

if [ "${NEST_SKIP_SERVICE:-0}" = "1" ]; then
  info "Skipping pm2 and the boot service (NEST_SKIP_SERVICE=1)."
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

  if pm2 pid nest 2>/dev/null | grep -q '[1-9]'; then
    info "Foray is running on port $NEST_PORT."
  else
    warn "Foray did not start. Check: pm2 logs nest"
  fi
fi

# ---------- done ----------

echo ""
info "Done! Next steps:"
echo ""
if [ "$OS" = Darwin ]; then
  MAC_NAME="$(scutil --get LocalHostName 2>/dev/null | tr 'A-Z' 'a-z' || hostname)"
  echo "  1. Install Tailscale from the App Store or https://tailscale.com/download"
  echo "     and sign in. Its CLI lives inside the app bundle:"
  echo "       alias tailscale=/Applications/Tailscale.app/Contents/MacOS/Tailscale"
  echo ""
  echo "  2. Open Foray from any device on your tailnet:"
  echo "       http://${MAC_NAME}:${NEST_PORT}"
  echo ""
  echo "  3. Or expose via Tailscale HTTPS (needed to install Foray as a"
  echo "     home-screen app on iPhone):"
  echo "       tailscale serve --bg ${NEST_PORT}"
  echo "       Then open https://${MAC_NAME}.<your-tailnet>.ts.net"
  echo ""
  echo "  4. Keep the Mac awake and logged in, or sessions vanish with it:"
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
  echo "  2. Open Foray from any device on your tailnet:"
  echo "       http://$(hostname):${NEST_PORT}"
  echo ""
  echo "  3. Or expose via Tailscale HTTPS:"
  echo "       tailscale serve --bg ${NEST_PORT}"
  echo "       Then open https://$(hostname).<your-tailnet>.ts.net"
  echo ""
fi
