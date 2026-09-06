// Where the running server and the served client came from, for the
// version handshake (src/shared/build.ts, src/version.ts).

import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { readBuildIdFromHtml } from '../shared/build.ts'

/**
 * `<short-sha>[-dirty]` for the checkout at `cwd`, or 'unknown' outside a
 * repo. Synchronous and meant to run once at startup: tsx loads the server
 * from source, so the commit at start is the code that is running until
 * the next restart. Untracked files count as dirty; dist/ is ignored by
 * git, so a fresh build alone never does.
 */
export function describeCheckout(cwd: string = process.cwd()): string {
  const git = (args: string[]): string =>
    execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
  try {
    const sha = git(['rev-parse', '--short', 'HEAD'])
    return git(['status', '--porcelain']) === '' ? sha : `${sha}-dirty`
  } catch {
    return 'unknown'
  }
}

/**
 * Build id of the client bundle on disk under `distDir` right now, or null
 * when nothing is built there. Read on every call rather than cached: the
 * bundle changes whenever `npm run build` runs, with no server restart.
 */
export async function readServedClientBuild(distDir: string): Promise<string | null> {
  try {
    return readBuildIdFromHtml(await fs.readFile(path.join(distDir, 'index.html'), 'utf-8'))
  } catch {
    return null
  }
}
