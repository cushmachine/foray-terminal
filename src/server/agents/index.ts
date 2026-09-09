// Which agents this Nest knows about, from the environment.
//
// By default every agent whose data directory exists is offered. NEST_AGENTS
// (comma-separated provider ids) narrows or forces the list; an unknown id
// there is a configuration error and fails loudly at startup. Each provider
// takes extra launch arguments from NEST_<ID>_ARGS, split on whitespace, so
// nothing here or in a provider hardcodes a model or a flag.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { claudeProvider } from './claude.ts'
import type { AgentProvider } from './types.ts'

interface Registration {
  id: string
  /** The agent's data directory under the home dir. */
  dir: (home: string) => string
  make: (dir: string, args: string[]) => AgentProvider
}

const REGISTRY: Registration[] = [
  {
    id: 'claude',
    dir: (home) => path.join(home, '.claude'),
    make: (dir, args) => claudeProvider({ dir, args }),
  },
]

/** Extra launch arguments for a provider, from NEST_<ID>_ARGS. */
export function argsFromEnv(env: NodeJS.ProcessEnv, id: string): string[] {
  const raw = env[`NEST_${id.toUpperCase()}_ARGS`] ?? ''
  return raw.split(/\s+/).filter(Boolean)
}

/**
 * The providers to offer. With NEST_AGENTS unset, those whose data
 * directory exists; with it set, exactly the ids it names. `exists` is
 * injectable so a test can stand in for the filesystem.
 */
export function providersFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  home: string = os.homedir(),
  exists: (dir: string) => boolean = (dir) => fs.existsSync(dir),
): AgentProvider[] {
  const wanted = env.NEST_AGENTS?.split(',').map((s) => s.trim()).filter(Boolean)
  const chosen = wanted
    ? wanted.map((id) => {
        const found = REGISTRY.find((r) => r.id === id)
        if (!found) throw new Error(`NEST_AGENTS names unknown agent "${id}" (known: ${REGISTRY.map((r) => r.id).join(', ')})`)
        return found
      })
    : REGISTRY.filter((r) => exists(r.dir(home)))
  return chosen.map((r) => r.make(r.dir(home), argsFromEnv(env, r.id)))
}
