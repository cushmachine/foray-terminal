module.exports = {
  apps: [{
    name: 'nest',
    script: 'src/server/index.ts',
    interpreter: './node_modules/.bin/tsx',
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
