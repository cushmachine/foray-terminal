module.exports = {
  apps: [{
    name: 'nest',
    // Builds the client, then execs the server (scripts/start.sh), so any
    // restart is a deploy. Changes to THIS file need
    // `pm2 restart ecosystem.config.cjs --update-env && pm2 save`.
    script: 'scripts/start.sh',
    interpreter: 'bash',
    env: {
      NODE_ENV: 'production',
      PORT: '3000',
    },
    watch: false,
    max_memory_restart: '200M',
    // Stamp every log line so connect/disconnect gaps can be measured.
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
  }],
}
