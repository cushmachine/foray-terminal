import { execFileSync } from 'node:child_process'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { BUILD_META_NAME } from './src/shared/build'

/** `<short-sha>[-dirty]` for the checkout vite runs in, or 'unknown'. */
function describeCheckout(): string {
  const git = (args: string[]): string =>
    execFileSync('git', args, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
  try {
    const sha = git(['rev-parse', '--short', 'HEAD'])
    return git(['status', '--porcelain']) === '' ? sha : `${sha}-dirty`
  } catch {
    return 'unknown'
  }
}

// One id per build: the commit plus a timestamp, so two builds of the same
// dirty tree still differ. The server reads it back out of dist/index.html
// and every page compares it with its own (src/version.ts).
const BUILD_ID = `${describeCheckout()}.${Date.now().toString(36)}`

function buildMeta(): Plugin {
  return {
    name: 'nest-build-meta',
    transformIndexHtml() {
      return [{ tag: 'meta', attrs: { name: BUILD_META_NAME, content: BUILD_ID }, injectTo: 'head' }]
    },
  }
}

export default defineConfig({
  plugins: [react(), buildMeta()],
  server: {
    host: '0.0.0.0',
    port: 5174,
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
      },
      '/ws': {
        target: 'http://localhost:3000',
        ws: true,
      },
    },
  },
})
