const fs = require('fs')

// A box that still has the pre-rename unit installed keeps Foray on the
// machine's default tmux socket: its sessions live there, and sessions
// cannot be moved between tmux servers, so switching would hide them and
// start a second server with nothing holding it. Detected rather than
// configured, because an owner who forgets should get the safe answer.
// scripts/tmux-server.sh and scripts/ensure-tmux-unit.sh spell the same
// rule — change all three together. Override in ecosystem.local.cjs.
const LEGACY_UNIT = '/etc/systemd/system/nest-tmux.service'
const defaultSocket = fs.existsSync(LEGACY_UNIT) ? '' : 'foray'

module.exports = {
  apps: [{
    name: 'foray',
    // Builds the client, then execs the server (scripts/start.sh), so any
    // restart is a deploy. Deploy with `npm run deploy` (scripts/deploy.sh):
    // it notices when this file changed and relaunches from it, which a
    // plain `pm2 restart` does not.
    script: 'scripts/start.sh',
    interpreter: 'bash',
    env: {
      NODE_ENV: 'production',
      PORT: '3000',
      // Foray binds loopback only; it is reached through `tailscale serve`
      // (or your own HTTPS proxy) forwarding to 127.0.0.1, never by opening
      // the port to the network directly. To bind wider on purpose — a LAN
      // with its own firewall, a container fronted by another proxy — set
      // HOST to '' (every interface) or a specific address; the access
      // token (~/.foray/token, `npm run token`) is still required either
      // way. See SECURITY.md.
      HOST: '127.0.0.1',
      // Extra args for the agent's resume command when reviving a past
      // session from the sidebar (src/server/agents), e.g. '--model x'.
      // One variable per agent: FORAY_<AGENT ID, uppercased>_ARGS. pm2 does
      // not load your shell profile, so set them here, not in ~/.bashrc.
      FORAY_CLAUDE_ARGS: '',
      // Foray runs tmux on its own socket, so it never adopts or touches a
      // tmux server you already run. See defaultSocket above for the one
      // exception, which is detected, not configured.
      FORAY_TMUX_SOCKET: defaultSocket,
    },
    watch: false,
    max_memory_restart: '200M',
    // Stamp every log line so connect/disconnect gaps can be measured.
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
  }],
}

// Per-machine overrides, if this box has any: an untracked
// ecosystem.local.cjs exporting { env: { ... } }. It is merged over the env
// above, so a local setting survives `git pull` instead of showing up as a
// conflict in a tracked file forever. Nothing here reads ~/.foray/env: that
// file holds secrets, and anything in pm2's env is inherited by every
// terminal session Foray spawns.
try {
  const local = require('./ecosystem.local.cjs')
  Object.assign(module.exports.apps[0].env, local.env ?? {})
} catch (err) {
  // No local file is the normal case. Anything else is worth seeing, since
  // a broken override would otherwise silently deploy the wrong config.
  if (err.code !== 'MODULE_NOT_FOUND') throw err
}
