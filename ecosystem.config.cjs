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
      // Foray runs tmux on its own socket ('foray'), so it never adopts or
      // touches a tmux server you already run. Leave this unset unless you
      // have Foray sessions from before the socket existed: those live on
      // the machine's default socket and cannot be moved between servers,
      // so such a box sets FORAY_TMUX_SOCKET to '' until every one of them
      // has been closed or resumed. Do that in ecosystem.local.cjs, below,
      // not here — here it would follow every install.
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
