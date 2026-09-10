// Rename and socket migration contracts: the nest_/foray_ session prefix,
// the named-session option, the tmux socket, and the localStorage key move.
//
// Run with: npx tsx --test src/server/__tests__/rename-migration.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createWindow, listWindows, SEP, tmuxSocketArgs, type TmuxExecutor } from '../tmux.ts'
import { fakeTmux } from './helpers.ts'
import { LAST_SESSION_KEY, draftKeyFor, storageGet } from '../../storage.ts'

/** One FORMAT line: id, name, cwd, then empty title/named so only the fields under test matter. */
function line(id: number, name: string, cwd: string): string {
  return [`$${id}`, name, cwd, '', 'bash', ''].join(SEP)
}

/** Run `fn` with `name` set to `value` (or unset), restoring whatever was there before. */
function withEnv<T>(name: string, value: string | undefined, fn: () => T): T {
  const prev = process.env[name]
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
  try {
    return fn()
  } finally {
    if (prev === undefined) delete process.env[name]
    else process.env[name] = prev
  }
}

/** An in-memory localStorage, installed as `window.localStorage` for one test. */
function installFakeLocalStorage(): Storage {
  const map = new Map<string, string>()
  const store = {
    getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
    setItem: (k: string, v: string) => {
      map.set(k, v)
    },
    removeItem: (k: string) => {
      map.delete(k)
    },
  } as unknown as Storage
  ;(globalThis as unknown as { window: Window }).window = { localStorage: store } as unknown as Window
  return store
}

// ---------------------------------------------------------------------------
// Contract 1: foray_ sessions are created; nest_ sessions stay visible.
// ---------------------------------------------------------------------------

test('listWindows returns both nest_-prefixed and foray_-prefixed sessions', async () => {
  const tmux = fakeTmux()
  tmux.add('legacy') // fakeTmux.add defaults to a nest_ name
  // fakeTmux's add() cannot be told to use a foray_ name directly (its
  // overrides type omits `name`, and its own new-session handler always
  // re-wraps with nest_ — see rules: do not modify fakeTmux). Set it on
  // the plain, mutable FakeSession field instead, after creation.
  const fresh = tmux.add('fresh')
  fresh.name = 'foray_fresh'
  const windows = await listWindows(tmux.exec, 'host')
  // An owner with a live nest_ session must not lose sight of it once Foray
  // starts naming new sessions foray_.
  assert.deepEqual(windows.map((w) => w.name).sort(), ['fresh', 'legacy'])
})

test('createWindow names new sessions with the foray_ prefix', async () => {
  const tmux = fakeTmux()
  await createWindow('shell', undefined, tmux.exec, 'host')
  const created = tmux.calls.find((args) => args[0] === 'new-session')
  assert.ok(created, 'expected a new-session call')
  const sessionName = created![created!.indexOf('-s') + 1]
  assert.equal(sessionName, 'foray_shell')
})

// ---------------------------------------------------------------------------
// Contract 2: the named-session marker reads @nest_named or @foray_named,
// writes only @foray_named.
// ---------------------------------------------------------------------------

test('the list-sessions format falls back from @foray_named to @nest_named', async () => {
  let format = ''
  const capture: TmuxExecutor = async (_cmd, args) => {
    if (args[0] === 'list-sessions') format = args[args.indexOf('-F') + 1]
    return { stdout: '', stderr: '' }
  }
  await listWindows(capture, 'host')
  // tmux resolves the fallback itself, from a single -F expression, so the
  // format text must name both options.
  assert.ok(format.includes('@foray_named'), `format should read the new option: ${format}`)
  assert.ok(format.includes('@nest_named'), `format should still fall back to the old option: ${format}`)
})

test('createWindow stamps the named flag as @foray_named, never @nest_named', async () => {
  const calls: string[][] = []
  const capture: TmuxExecutor = async (_cmd, args) => {
    calls.push(args)
    // The session-name prefix is contract 1's concern, not this one: reply
    // with a name createWindow's own parser accepts today, so a prefix
    // mismatch there can never masquerade as a failure of this contract.
    if (args[0] === 'new-session') return { stdout: `${line(3, 'nest_mywindow', '/home/user')}\n`, stderr: '' }
    return { stdout: '', stderr: '' }
  }
  await createWindow('mywindow', '/home/user', capture, 'host')
  const stamp = calls.find((args) => args[0] === 'set' && args.some((a) => a.endsWith('_named')))
  assert.ok(stamp, 'expected a set call stamping the named option')
  assert.ok(stamp!.includes('@foray_named'), `expected @foray_named, got ${JSON.stringify(stamp)}`)
  assert.ok(!stamp!.includes('@nest_named'), `must not still write the legacy option: ${JSON.stringify(stamp)}`)
})

// ---------------------------------------------------------------------------
// Contract 3: a pure tmuxSocketArgs() spells the socket once.
// ---------------------------------------------------------------------------

test('tmuxSocketArgs: unset FORAY_TMUX_SOCKET means the dedicated "foray" socket', () => {
  withEnv('FORAY_TMUX_SOCKET', undefined, () => {
    assert.deepEqual(tmuxSocketArgs(), ['-L', 'foray'])
  })
})

test('tmuxSocketArgs: an empty value means the machine\'s default tmux socket', () => {
  withEnv('FORAY_TMUX_SOCKET', '', () => {
    assert.deepEqual(tmuxSocketArgs(), [])
  })
})

test('tmuxSocketArgs: a named socket is passed through as -L', () => {
  withEnv('FORAY_TMUX_SOCKET', 'foray-test', () => {
    assert.deepEqual(tmuxSocketArgs(), ['-L', 'foray-test'])
  })
})

// ---------------------------------------------------------------------------
// Contract 4: storage keys move to foray:*, each falling back once to the
// nest:* key and rewriting under the new one.
// ---------------------------------------------------------------------------

test('storage keys move to the foray: namespace', () => {
  assert.equal(LAST_SESSION_KEY, 'foray:lastSession')
  assert.equal(draftKeyFor(7), 'foray:draft:7')
})

test('storageGet falls back once to the legacy lastSession key and rewrites it', () => {
  const store = installFakeLocalStorage()
  store.setItem('nest:lastSession', '42')
  // Hardcoded rather than LAST_SESSION_KEY: today that constant still *is*
  // 'nest:lastSession', which would make the first assertion pass by
  // coincidence (reading the same key it just wrote) instead of proving a
  // fallback. The "storage keys move" test above pins the constant itself.
  const key = 'foray:lastSession'
  assert.equal(storageGet(key), '42', 'should fall back to the legacy value')
  assert.equal(store.getItem(key), '42', 'should rewrite it under the new key')
  // The fallback happens once: a later write to the legacy key (some old
  // tab, say) must not be preferred over the value already migrated.
  store.setItem('nest:lastSession', 'stale')
  assert.equal(storageGet(key), '42', 'should prefer the already-migrated value')
})

test('storageGet falls back once for a per-session draft key too', () => {
  const store = installFakeLocalStorage()
  store.setItem('nest:draft:7', 'unsent text')
  // Hardcode the new key rather than reading it off draftKeyFor(7): today
  // draftKeyFor still returns the nest: form, which would make this pass
  // by coincidence (same key on both sides) rather than by exercising the
  // fallback. The "storage keys move" test above pins draftKeyFor itself.
  const key = 'foray:draft:7'
  assert.equal(storageGet(key), 'unsent text', 'should fall back to the legacy draft value')
  assert.equal(store.getItem(key), 'unsent text', 'should rewrite the draft under the new key')
})
