import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { BUILD_META_NAME } from './src/shared/build.ts'
// Server code is fine here: this config runs in node at build time and is
// never part of the bundle.
import { describeCheckout } from './src/server/build.ts'

// One id per build: the commit plus a timestamp, so two builds of the same
// dirty tree still differ. The server reads it back out of dist/index.html
// and every page compares it with its own (src/version.ts).
const BUILD_ID = `${describeCheckout()}.${Date.now().toString(36)}`

function buildMeta(): Plugin {
  return {
    name: 'foray-build-meta',
    transformIndexHtml() {
      return [{ tag: 'meta', attrs: { name: BUILD_META_NAME, content: BUILD_ID }, injectTo: 'head' }]
    },
  }
}

export default defineConfig({
  plugins: [react(), buildMeta()],
})
