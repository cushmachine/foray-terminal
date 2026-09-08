#!/usr/bin/env bash
# Nest installer — run on a fresh Ubuntu VPS (22.04+).
#
# What it does:
#   1. Installs system deps (tmux, build tools for node-pty)
#   2. Installs Node.js 24 via nvm
#   3. Clones the repo (or uses an existing checkout)
#   4. Runs npm install (dev deps included: prod runs with tsx and vite)
#   5. Writes the tmux config Nest expects
#   6. Installs pm2, deploys nest under it (npm run deploy), and registers
#      pm2 with systemd so nest comes back after a reboot
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/cushmachine/nest/main/install.sh | bash
#
# Or, if the repo is private:
#   git clone https://github.com/cushmachine/nest.git ~/nest
#   cd ~/nest && bash install.sh
#
# Environment variables:
#   NEST_DIR   — where to install (default: ~/nest)
#   NEST_SKIP_SERVICE — set to 1 to skip pm2 and the boot service (for Docker)
#
# The port is 3000, set in ecosystem.config.cjs.

set -euo pipefail

NEST_DIR="${NEST_DIR:-$HOME/nest}"
NEST_PORT=3000
NODE_MAJOR="24"

info()  { printf '\033[1;32m→\033[0m %s\n' "$*"; }
warn()  { printf '\033[1;33m!\033[0m %s\n' "$*"; }
die()   { printf '\033[1;31m✗\033[0m %s\n' "$@" >&2; exit 1; }

# ---------- preflight ----------

[ "$(uname)" = "Linux" ] || die "Nest runs on Linux. This is $(uname)."

if [ "$(id -u)" -ne 0 ]; then
  warn "Not running as root. Some steps may need sudo."
  SUDO="sudo"
else
  SUDO=""
fi

# ---------- system deps ----------

info "Installing system packages (tmux, build-essential, python3)..."
if command -v apt-get >/dev/null 2>&1; then
  ${SUDO:+$SUDO} apt-get update -qq
  ${SUDO:+$SUDO} apt-get install -y -qq tmux build-essential python3 git curl >/dev/null
else
  die "Only apt-based distros (Ubuntu/Debian) are supported."
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
  info "Cloning Nest into $NEST_DIR..."
  if ! git clone https://github.com/cushmachine/nest.git "$NEST_DIR" 2>/dev/null; then
    die "Clone failed. If the repo is private, clone it manually first:" \
        "  git clone https://github.com/cushmachine/nest.git $NEST_DIR" \
        "  cd $NEST_DIR && bash install.sh"
  fi
fi

cd "$NEST_DIR"

# ---------- npm install ----------

info "Installing npm dependencies (includes compiling node-pty)..."
npm install 2>&1 | tail -5

# ---------- tmux config ----------

TMUX_CONF="$HOME/.tmux.conf"

# Check whether the settings Nest needs are already present, regardless
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
  info "tmux config already has the settings Nest needs."
elif [ -f "$TMUX_CONF" ]; then
  warn "Existing ~/.tmux.conf found — appending Nest settings."
  {
    echo ""
    echo "# Added by Nest installer"
    $has_mouse_off  || echo "set -g mouse off"
    $has_history_limit || echo "set -g history-limit 10000"
    $has_extended_keys || echo "set -s extended-keys always"
    $has_extended_keys_format || echo "set -s extended-keys-format csi-u"
  } >> "$TMUX_CONF"
else
  info "Writing tmux config..."
  cat > "$TMUX_CONF" <<'TMUX'
# Nest: scrollback comes from tmux history, served as HTML to the browser.
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
  info "Start nest yourself with: npm run deploy"
else
  if ! command -v pm2 >/dev/null 2>&1; then
    info "Installing pm2..."
    npm install -g pm2 2>&1 | tail -1
  fi

  # Typechecks, then starts nest from ecosystem.config.cjs; pm2 runs
  # scripts/start.sh, which builds the client and starts the server.
  info "Deploying nest under pm2..."
  npm run deploy

  # `pm2 startup` normally prints a root command for the user to paste;
  # run it directly. PATH is passed through so the unit finds this node.
  info "Registering pm2 with systemd..."
  ${SUDO:+$SUDO} env PATH="$PATH" "$(command -v pm2)" startup systemd -u "$(whoami)" --hp "$HOME" >/dev/null
  pm2 save >/dev/null

  if pm2 pid nest 2>/dev/null | grep -q '[1-9]'; then
    info "Nest is running on port $NEST_PORT."
  else
    warn "Nest did not start. Check: pm2 logs nest"
  fi
fi

# ---------- done ----------

echo ""
info "Done! Next steps:"
echo ""
echo "  1. Install Tailscale (if not already):"
echo "       curl -fsSL https://tailscale.com/install.sh | sh && tailscale up"
echo ""
echo "  2. Open Nest from any device on your tailnet:"
echo "       http://$(hostname):${NEST_PORT}"
echo ""
echo "  3. Or expose via Tailscale HTTPS:"
echo "       tailscale serve --bg ${NEST_PORT}"
echo "       Then open https://$(hostname).<your-tailnet>.ts.net"
echo ""
