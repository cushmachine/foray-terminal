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
  }],
}
