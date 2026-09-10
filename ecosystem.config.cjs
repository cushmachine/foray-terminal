module.exports = {
  apps: [{
    name: 'nest',
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
    },
    watch: false,
    max_memory_restart: '200M',
    // Stamp every log line so connect/disconnect gaps can be measured.
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
  }],
}
