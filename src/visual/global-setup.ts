// Runs once before the visual suite: gives the browser a session of the
// suite's own to open on.
//
// A fresh browser profile has no nest:lastSession, so the first page load
// attaches to the first session tmux lists, which on this machine is
// someone's live shell; since only the active terminal holds a pty, that
// attach takes over their real tab. So one nest_visual-* session is created
// here (global-teardown removes it with the rest) and a storage state that
// points nest:lastSession at it is written for playwright.config.ts to load
// into every browser context. The seed's cwd is a small fixture directory
// with one markdown file, so the file-panel specs have something to open
// and the editor spec works on a short, known document rather than
// whatever a real checkout holds.

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import type { FullConfig } from '@playwright/test'
import { LAST_SESSION_KEY } from '../storage.ts'
import { Auth, SESSION_COOKIE } from '../server/auth.ts'
import { VISUAL_TOKEN } from '../../playwright.config.ts'
import { SESSION_PREFIX } from './helpers.ts'

/** tmux session name of the seed; the prefix is what global-teardown keys on. */
const SEED_SESSION = `nest_${SESSION_PREFIX}seed`

const tmux = (args: string[]): string =>
  execFileSync('tmux', args, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()

export default function globalSetup(config: FullConfig): void {
  const { baseURL, storageState } = config.projects[0].use
  if (typeof storageState !== 'string' || !baseURL) {
    throw new Error('playwright.config.ts must set use.baseURL and a use.storageState path')
  }
  const cwd = path.resolve(path.dirname(storageState), 'seed-cwd')
  fs.mkdirSync(cwd, { recursive: true })
  fs.writeFileSync(path.join(cwd, 'README.md'), '# Seed\n\nA short file for the editor spec.\n')
  try {
    tmux(['has-session', '-t', SEED_SESSION])
  } catch {
    // The same options Foray's own create applies, so the seed looks like
    // any other session in the list.
    tmux(['new-session', '-d', '-s', SEED_SESSION, '-c', cwd])
    tmux(['set', '-t', SEED_SESSION, 'status', 'off'])
  }
  // `$12` from tmux; the app stores the bare number.
  const id = tmux(['display-message', '-p', '-t', SEED_SESSION, '#{session_id}']).replace(/^\$/, '')
  fs.mkdirSync(path.dirname(storageState), { recursive: true })
  // Logged in from the first page load: the cookie the server would set
  // for VISUAL_TOKEN, minted here with the same derivation.
  const { hostname } = new URL(baseURL)
  const cookie = {
    name: SESSION_COOKIE,
    value: new Auth(VISUAL_TOKEN).issueSession(),
    domain: hostname,
    path: '/',
    expires: -1,
    httpOnly: true,
    secure: false,
    sameSite: 'Strict' as const,
  }
  fs.writeFileSync(storageState, JSON.stringify({
    cookies: [cookie],
    origins: [{ origin: baseURL, localStorage: [{ name: LAST_SESSION_KEY, value: id }] }],
  }))
}
