#!/usr/bin/env node
// The `foray` CLI: setup / token / update / start. Each subcommand execs an
// existing script rather than reimplementing it — see the "Reuse map" in
// this project's longrun plan for why. install.sh stays the one place that
// knows how to install system deps, Node, pm2 and the boot service; this
// finds it and runs it with the caller's environment passed through
// (FORAY_SKIP_SERVICE, FORAY_ALLOW_NO_TAILSCALE, FORAY_ALLOW_ROOT — see
// install.sh's own header for what each does).

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
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
           print the access token. Seeds FORAY_DIR (default ~/foray) from
           this package if nothing is there yet, then wraps install.sh —
           see FORAY_SKIP_SERVICE, FORAY_ALLOW_NO_TAILSCALE and
           FORAY_ALLOW_ROOT in its header.
  token    Print the access token a browser needs to log in.
  update   Pull and redeploy an existing checkout (FORAY_DIR, default
           ~/foray), or reinstall this package and refresh that directory
           from it if that isn't a git checkout.
  start    Run the server in the foreground with no build step, from the
           checkout at FORAY_DIR (default ~/foray) — for Docker or local
           dev against an already-built dist/. Not what 'foray setup'
           uses for the real deploy; that's install.sh under pm2.

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

/** Like execTo, but returns to the caller instead of exiting on success. */
function runStep(cmd, args, opts) {
  const result = spawnSync(cmd, args, { stdio: 'inherit', ...opts })
  if (result.error) {
    console.error(`foray: could not run ${cmd}: ${result.error.message}`)
    process.exit(1)
  }
  if (result.status !== 0) process.exit(result.status ?? 1)
}

function forayDir() {
  return process.env.FORAY_DIR || path.join(os.homedir(), 'foray')
}

// What a checkout never needs a copy of: dependencies get reinstalled by
// install.sh/npm at the destination, and the rest is this repo's own dev
// state, not the app.
const SKIP_COPY = new Set(['node_modules', '.git', 'dist.next', '.playwright'])

/**
 * Populate `dir` with this package's own files — the server source, the
 * already-built `dist/` (this package's whole reason to exist; prepack
 * built it before this ever shipped), scripts and install.sh. Overwrites
 * whatever is already there, so callers decide first whether that's wanted
 * (cmdSetup does not call this over an existing install; cmdUpdate does,
 * deliberately, to actually deliver an update). `src` defaults to this
 * process's own package (PKG_ROOT); cmdUpdate passes a freshly-resolved
 * one instead — see the comment there for why that matters.
 */
function seedFromPackage(dir, src = PKG_ROOT) {
  try {
    fs.cpSync(src, dir, {
      recursive: true,
      filter: (p) => !SKIP_COPY.has(path.basename(p)),
    })
  } catch (err) {
    console.error(`foray: could not copy Foray into ${dir}: ${err.message}`)
    process.exit(1)
  }
}

function cmdSetup() {
  const dir = forayDir()
  // install.sh clones from GitHub only when $FORAY_DIR has no package.json
  // yet. The repo is private today, so for the one caller that matters —
  // a stranger who just ran `npx foray-terminal setup` — that clone would
  // simply fail. Seed it from this package instead: the tarball already
  // carries the server source and a built dist/, which is the whole point
  // of shipping a package rather than pointing people at install.sh alone.
  if (fs.existsSync(path.join(dir, 'package.json'))) {
    console.log(`foray: using the existing install at ${dir}`)
  } else {
    console.log(`foray: copying Foray into ${dir}`)
    seedFromPackage(dir)
  }
  // Passing FORAY_DIR explicitly (rather than trusting it's already set)
  // means install.sh's "existing checkout" branch is what runs next,
  // never the clone — regardless of what the caller's shell had set.
  runStep('bash', [path.join(dir, 'install.sh')], {
    cwd: dir,
    env: { ...process.env, FORAY_DIR: dir },
  })
  // `npx foray-terminal setup` only ever downloads this CLI into npx's
  // ephemeral cache — nothing above puts a `foray` command on PATH for
  // next time. Without this, README's and DEPLOY.md's `foray token` /
  // `foray update` would be "command not found" for exactly the install
  // path they document. Best effort: setup itself already succeeded, so a
  // failure here is a convenience miss, not a reason to report the whole
  // command as failed.
  // Installed from THIS package's own directory, never `foray-terminal@latest`
  // from the registry: the copy running right now is the one the user chose
  // (an npx download, or a local tarball under test), and fetching "latest"
  // here would put a different — possibly older — version on their PATH than
  // the one that just set their machine up, without saying so.
  console.log('foray: installing the `foray` command globally (for `foray token` / `foray update` later)...')
  const globalInstall = spawnSync('npm', ['i', '-g', PKG_ROOT], { stdio: 'inherit' })
  if (globalInstall.error || globalInstall.status !== 0) {
    console.error(
      "foray: could not install the `foray` command globally. Use `npx foray-terminal token` /\n" +
        "`npx foray-terminal update` instead, or run 'npm i -g foray-terminal' yourself later.",
    )
  }
}

function cmdToken() {
  execTo('bash', [path.join(PKG_ROOT, 'scripts', 'token.sh')])
}

function cmdUpdate() {
  const dir = forayDir()
  if (fs.existsSync(path.join(dir, '.git'))) {
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
  if (!process.env.FORAY_UPDATE_REEXEC) {
    console.log(`foray: ${dir} is not a git checkout; updating the installed package instead`)
    runStep('npm', ['i', '-g', 'foray-terminal@latest'])
    // `npm i -g` above updates the *global* install; it does nothing to this
    // running process. When this file was launched via `npx foray-terminal
    // update`, PKG_ROOT (top of file) is npx's own cache copy of whatever
    // version started this run, and that never updates itself mid-process —
    // so seeding from PKG_ROOT here would silently reinstall the *old*
    // files while printing "refreshing from the updated package". Resolve
    // where `npm i -g` actually put the new package and re-exec its own
    // bin/foray.mjs so the rest of update — seeding FORAY_DIR and
    // redeploying — runs as the new code reading the new files, not old
    // code reading new files it may not even know how to handle correctly.
    // FORAY_UPDATE_REEXEC marks the re-exec so the new process seeds and
    // redeploys directly instead of looping back through this same step.
    const globalRoot = spawnSync('npm', ['root', '-g'], { encoding: 'utf8' })
    if (globalRoot.error || globalRoot.status !== 0) {
      console.error(
        `foray: could not resolve the global npm root: ${(globalRoot.stderr || globalRoot.error?.message || '').trim()}`,
      )
      process.exit(1)
    }
    const newBin = path.join(globalRoot.stdout.trim(), 'foray-terminal', 'bin', 'foray.mjs')
    if (!fs.existsSync(newBin)) {
      console.error(`foray: expected the updated package's CLI at ${newBin}, but it is not there.`)
      process.exit(1)
    }
    execTo(process.execPath, [newBin, 'update'], {
      env: { ...process.env, FORAY_DIR: dir, FORAY_UPDATE_REEXEC: '1' },
    })
  }
  // cmdSetup leaves an existing install alone on purpose; update's whole
  // job is the opposite of that, so it seeds directly rather than calling
  // cmdSetup — otherwise "update" would upgrade the CLI and redeploy the
  // same stale files every time.
  console.log(`foray: refreshing ${dir} from the updated package`)
  seedFromPackage(dir)
  console.log('foray: redeploying')
  execTo('bash', [path.join(dir, 'install.sh')], {
    cwd: dir,
    env: { ...process.env, FORAY_DIR: dir },
  })
}

function cmdStart() {
  // The foreground server, not scripts/start.sh: no vite build, no pm2.
  // Runs from FORAY_DIR — the checkout 'foray setup'/'foray update' seed
  // and `npm install` in — not from this package's own install location:
  // a plain `npm i -g foray-terminal` installs production dependencies
  // only, and tsx (needed to run the TypeScript server directly, see
  // CLAUDE.md's "Prod runs ... with tsx") is a dev dependency, so it is
  // FORAY_DIR's node_modules that has it, never this package's own.
  const dir = forayDir()
  const tsx = path.join(dir, 'node_modules', '.bin', 'tsx')
  if (!fs.existsSync(tsx)) {
    console.error(
      `foray: ${tsx} not found.\n` +
        `'foray start' runs the server straight from an existing checkout at ${dir}\n` +
        `(FORAY_DIR) — it does not install or build anything itself. Run\n` +
        `'foray setup' there first, or 'npm install' if it's already a checkout\n` +
        `just missing its dev dependencies.`,
    )
    process.exit(1)
  }
  execTo(tsx, ['src/server/index.ts'], {
    cwd: dir,
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
