// Visual and interaction regression suite: layout, sidebar, terminal, keyboard.
//
// Run with: npm run test:visual
//
// The webServer command builds the client into .playwright/root-<port>/dist and
// runs the real Foray server from that root, so production code paths
// (static dist, SPA fallback, version handshake) are what gets tested.
// vite is invoked directly rather than `npm run build`: the build script
// type-checks first, and a red unit test (an import of a helper that does
// not exist yet) must not stop the visual suite from running.
// Sessions the tests create are real tmux sessions named foray_visual-*, on
// the throwaway socket foray-test (FORAY_TMUX_SOCKET below) rather than any
// socket a person's own sessions live on; global-teardown removes any that a
// failed test left behind. global-setup creates one of them up front and
// points every browser context's foray:lastSession at it (via storageState),
// so a page load never attaches to someone's live session.

import { defineConfig } from '@playwright/test'

// Override with VISUAL_PORT=<n> to run two copies of the suite side by side
// (each gets its own build root and results directory).
export const VISUAL_PORT = Number(process.env.VISUAL_PORT) || 3456
const ROOT = `.playwright/root-${VISUAL_PORT}`
// Written by global-setup; outside outputDir, which Playwright empties.
const STORAGE_STATE = `.playwright/state-${VISUAL_PORT}.json`
// The token the server under test accepts; global-setup turns it into the
// session cookie every browser context starts with, so no spec logs in.
export const VISUAL_TOKEN = 'visual-suite-token-0123456789'

// The visual suite drives real tmux, so it runs on a throwaway socket and can
// never see — or kill — sessions someone actually uses. Fixed, and
// deliberately NOT read from process.env.FORAY_TMUX_SOCKET: that variable is
// exactly what SECURITY.md and DEPLOY.md teach an owner to export (e.g.
// FORAY_TMUX_SOCKET=foray, the production socket) for their own shell, and
// global-teardown.ts kills whatever server this socket names — so honouring
// an ambient value here would hand a stray exported env var the power to
// kill every live Foray session the moment someone runs `npm run
// test:visual`. The runner process (helpers.ts, via tmuxSocketArgs) and the
// server under test are separate processes and must agree: set it here for
// the runner, pass it through in the webServer command below — never
// through the caller's own environment.
export const TMUX_SOCKET = 'foray-test'
process.env.FORAY_TMUX_SOCKET = TMUX_SOCKET

export default defineConfig({
  testDir: 'src/visual',
  testMatch: '**/*.spec.ts',
  globalSetup: './src/visual/global-setup.ts',
  globalTeardown: './src/visual/global-teardown.ts',
  outputDir: `.playwright/results-${VISUAL_PORT}`,
  // Creating a session is a real tmux new-session plus an attach; on this
  // small VM under load that can take a few seconds each, and some specs
  // create several.
  timeout: 60_000,
  expect: { timeout: 10_000 },
  // One worker: every test shares one tmux server and one Foray server.
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: `http://127.0.0.1:${VISUAL_PORT}`,
    storageState: STORAGE_STATE,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    // Software WebGL so the xterm WebGL renderer can load headless.
    launchOptions: {
      args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
    },
  },
  webServer: {
    command: [
      `mkdir -p ${ROOT}`,
      `npx vite build --outDir ${ROOT}/dist --emptyOutDir`,
      `cd ${ROOT} && NODE_ENV=production PORT=${VISUAL_PORT} FORAY_TOKEN=${VISUAL_TOKEN} FORAY_TMUX_SOCKET=${TMUX_SOCKET} ../../node_modules/.bin/tsx ../../src/server/index.ts`,
    ].join(' && '),
    port: VISUAL_PORT,
    reuseExistingServer: false,
    timeout: 90_000,
  },
})
