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
      // Foray listens on every interface unless HOST is set. It always
      // requires the access token (~/.foray/token, `npm run token`), so
      // this is safe on a private network; on a machine with a public
      // address, set HOST to '127.0.0.1' and reach it through
      // `tailscale serve` (see SECURITY.md).
      // HOST: '127.0.0.1',
      // Extra args for the agent's resume command when reviving a past
      // session from the sidebar (src/server/agents), e.g. '--model x'.
      // One variable per agent: NEST_<AGENT ID, uppercased>_ARGS. pm2 does
      // not load your shell profile, so set them here, not in ~/.bashrc.
      NEST_CLAUDE_ARGS: '',
    },
    watch: false,
    max_memory_restart: '200M',
    // Stamp every log line so connect/disconnect gaps can be measured.
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
  }],
}
