// npm postinstall: node-pty's prebuilt spawn-helper can ship without its
// execute bit on macOS, which makes every spawn fail with "posix_spawnp
// failed". Restore it. Idempotent; does nothing where there are no prebuilds
// (Linux compiles node-pty into build/Release, which is already executable).
import { chmodSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const dir = join('node_modules', 'node-pty', 'prebuilds')
if (existsSync(dir)) {
  for (const platform of readdirSync(dir)) {
    const helper = join(dir, platform, 'spawn-helper')
    if (existsSync(helper)) chmodSync(helper, 0o755)
  }
}
