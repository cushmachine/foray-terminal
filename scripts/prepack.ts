// What `npm pack` and `npm publish` run before packing the tarball.
//
// It checks dist/ and never writes it. That is the whole point: package.json's
// `files` ships dist/, so pack needs the built client to be there, and the
// obvious way to guarantee that — prepack running `npm run build`, which is
// what it used to do — runs vite straight into the dist/ a running server is
// serving at that moment. The server keeps its old code, the page that
// reloads gets the new bundle, and Foray reports a drift nobody asked for
// (the banner in src/VersionBanner.tsx). Packing is not deploying; on this
// box the only thing that builds is scripts/start.sh, under pm2, which
// restarts the server in the same breath.
//
// So: pack whatever dist/ already holds, and refuse when that is provably
// not this checkout's code. `npm run deploy` is what makes it this
// checkout's code. (`npm pack --ignore-scripts` skips this check and packs
// dist/ exactly as it lies; bin/foray.mjs packs that way on purpose.)

import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { commitOf } from '../src/shared/build.ts'
import { describeCheckout, readServedClientBuild } from '../src/server/build.ts'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function fail(...lines: string[]): never {
  for (const line of lines) console.error(`[prepack] ${line}`)
  process.exit(1)
}

const built = await readServedClientBuild(path.join(root, 'dist'))
if (built === null) {
  fail(
    'dist/ holds no built client, and pack ships dist/ as it is rather than building it.',
    'Run `npm run deploy` (or `npm run build`, where no server is serving this',
    'directory) and pack again.',
  )
}

const checkout = describeCheckout(root)
const from = commitOf(built)
if (checkout === 'unknown' || from === 'unknown') {
  console.warn(`[prepack] packing dist/ (build ${built}); no git here, so which commit it came from is unchecked`)
} else if (from !== checkout) {
  fail(
    `dist/ was built from ${from} and this checkout is ${checkout}, so the tarball's src/ and`,
    'dist/ would not be the same code — and pack ships dist/ as it is rather than building it.',
    'Run `npm run deploy` (or `npm run build`, where no server is serving this',
    'directory) and pack again.',
  )
} else if (checkout.endsWith('-dirty')) {
  console.warn(
    `[prepack] packing dist/ (build ${built}); the checkout is dirty, so "${checkout}" on both sides ` +
      'proves nothing about whether the bundle matches the source going into the tarball',
  )
} else {
  console.log(`[prepack] packing dist/ as it is: build ${built}, from this checkout at ${checkout}`)
}
