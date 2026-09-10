#!/usr/bin/env node
// The `foray` CLI: setup / token / update / start. Each subcommand execs an
// existing script rather than reimplementing it — see the "Reuse map" in
// this project's longrun plan for why. install.sh stays the one place that
// knows how to get Foray running; this just finds it and runs it with the
// caller's environment passed through untouched (FORAY_DIR,
// FORAY_SKIP_SERVICE, FORAY_ALLOW_NO_TAILSCALE, FORAY_ALLOW_ROOT — see
// install.sh's own header for what each does).

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import os from 'node:os'
import path from 'node:path'

// Resolved from this file's own location, not process.cwd(): once this
// package is installed globally (npm i -g / npx), the caller can be
// standing anywhere.
const PKG_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

const USAGE = `Usage: foray <command>

Commands:
  setup    Install Foray on this machine (tmux, pm2, the boot service) and
           print the access token. Wraps install.sh — see FORAY_DIR,
           FORAY_SKIP_SERVICE, FORAY_ALLOW_NO_TAILSCALE and FORAY_ALLOW_ROOT
           in its header.
  token    Print the access token a browser needs to log in.
  update   Pull and redeploy an existing checkout (FORAY_DIR, default
           ~/foray), or reinstall this package if that isn't a git checkout.
  start    Run the server in the foreground with no build step — for
           Docker or local dev against an already-built dist/. Not what
           'foray setup' uses; that deploys under pm2 via install.sh.

Environment variables come from your shell; foray passes them through
rather than setting its own.
`

/** Exec `cmd`, replacing this process's exit code with its own. Never returns. */
function execTo(cmd, args, opts = {}) {
  const result = spawnSync(cmd, args, { stdio: 'inherit', ...opts })
  if (result.error) {
    console.error(`foray: could not run ${cmd}: ${result.error.message}`)
    process.exit(1)
  }
  // A killing signal has no exit code; treat it as failure rather than 0.
  process.exit(result.status ?? 1)
}

function forayDir() {
  return process.env.FORAY_DIR || path.join(os.homedir(), 'foray')
}

function runStep(cmd, args, opts) {
  const result = spawnSync(cmd, args, { stdio: 'inherit', ...opts })
  if (result.error) {
    console.error(`foray: could not run ${cmd}: ${result.error.message}`)
    process.exit(1)
  }
  if (result.status !== 0) process.exit(result.status ?? 1)
}

function cmdSetup() {
  // install.sh is the only implementation of "get Foray running here";
  // it clones or reuses $FORAY_DIR itself, so nothing here decides that.
  execTo('bash', [path.join(PKG_ROOT, 'install.sh')])
}

function cmdToken() {
  execTo('bash', [path.join(PKG_ROOT, 'scripts', 'token.sh')])
}

function cmdUpdate() {
  const dir = forayDir()
  if (existsSync(path.join(dir, '.git'))) {
    const status = spawnSync('git', ['status', '--porcelain'], { cwd: dir, encoding: 'utf8' })
    if (status.error || status.status !== 0) {
      console.error(`foray: 'git status' failed in ${dir}`)
      process.exit(1)
    }
    if (status.stdout.trim() !== '') {
      console.error(`foray: ${dir} has local changes; leaving it alone. git status --porcelain:`)
      console.error(status.stdout)
      process.exit(1)
    }
    console.log(`foray: updating the checkout at ${dir}`)
    // Never `git reset` or otherwise discard work — a fast-forward only
    // pull is the most this does, and it already refused above if that
    // would have to throw anything away.
    runStep('git', ['pull', '--ff-only'], { cwd: dir })
    runStep('npm', ['install'], { cwd: dir })
    runStep('npm', ['run', 'deploy'], { cwd: dir })
    return
  }
  console.log(`foray: ${dir} is not a git checkout; updating the installed package instead`)
  runStep('npm', ['i', '-g', 'foray-terminal@latest'])
  console.log('foray: re-running setup to redeploy')
  cmdSetup()
}

function cmdStart() {
  // The foreground server, not scripts/start.sh: no vite build, no pm2.
  // Mirrors package.json's own "start" script exactly, run from this
  // package's own root (never process.cwd()) so `dist` resolves the same
  // way whether this is invoked as `foray start` or `npm start`. Assumes
  // dist/ is already built (prepack does that for a published package)
  // and that node_modules has the dev dependencies tsx needs to run the
  // TypeScript server directly — see CLAUDE.md's "Prod runs ... with tsx".
  const tsx = path.join(PKG_ROOT, 'node_modules', '.bin', 'tsx')
  execTo(tsx, ['src/server/index.ts'], {
    cwd: PKG_ROOT,
    env: { ...process.env, NODE_ENV: 'production' },
  })
}

const command = process.argv[2]

switch (command) {
  case undefined:
  case '-h':
  case '--help':
    process.stdout.write(USAGE)
    process.exit(0)
    break
  case 'setup':
    cmdSetup()
    break
  case 'token':
    cmdToken()
    break
  case 'update':
    cmdUpdate()
    break
  case 'start':
    cmdStart()
    break
  default:
    console.error(`foray: unknown command '${command}'\n`)
    process.stderr.write(USAGE)
    process.exit(1)
}
