// Session naming: the tmux name of a session the user has not named
// follows the title its program sets, so every tool calls it the same
// thing.
//
// Run with: npx tsx --test src/server/__tests__/session-names.test.ts

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { listWindowSessions, listWindows, mirrorTitles, slugName, unmarkNamed } from '../tmux.ts'
import { fakeTmux } from './helpers.ts'

test('slugName makes a short tmux-safe name and falls back', () => {
  assert.equal(slugName('Session history: sidebar plan', 'claude'), 'session-history-sidebar')
  assert.equal(slugName('Session recovery after crash', 'claude'), 'session-recovery-after')
  assert.equal(slugName('✳ Mega refactor', 'claude'), 'mega-refactor')
  assert.equal(slugName('Mobile.opt (v2)', 'claude'), 'mobile-opt-v2')
  assert.equal(slugName('...', 'claude'), 'claude')
  assert.equal(slugName('', 'codex'), 'codex')
  assert.ok(slugName('a'.repeat(50), 'x').length <= 24)
})

test('mirrorTitles renames unnamed titled sessions and leaves the rest alone', async () => {
  const tmux = fakeTmux()
  tmux.add('bash', { title: '✳ Voice input mode for mobile', command: 'claude' })
  tmux.add('explore', { title: '✳ Mega refactor', command: 'claude', named: true })
  tmux.add('bash-1', { title: '', command: 'bash' })
  tmux.add('voice-input-mode-for', { title: 'Voice input mode for mobile', command: 'claude' })
  const before = await listWindows(tmux.exec, 'host')
  const after = await mirrorTitles(before, tmux.exec)
  assert.deepEqual(after.map((w) => w.name), ['voice-input-mode-for-1', 'explore', 'bash-1', 'voice-input-mode-for'])
  // The first wanted "voice-input-mode-for", which the last already holds.
  assert.deepEqual(tmux.calls.filter((c) => c[0] === 'rename-session').map((c) => c.at(-1)), [
    'nest_voice-input-mode-for',
    'nest_voice-input-mode-for-1',
  ])
  assert.equal(tmux.sessions.get(0)?.name, 'nest_voice-input-mode-for-1')
  // Already mirrored: a second pass changes nothing.
  const calls = tmux.calls.length
  assert.deepEqual(await mirrorTitles(await listWindows(tmux.exec, 'host'), tmux.exec), after)
  assert.equal(tmux.calls.filter((c) => c[0] === 'rename-session').length, 2, `no new renames (${tmux.calls.length - calls} calls)`)
})

test('mirrorTitles keeps the last name when the title goes away', async () => {
  const tmux = fakeTmux()
  const s = tmux.add('bash', { title: 'Fix the tests', command: 'claude' })
  await mirrorTitles(await listWindows(tmux.exec, 'host'), tmux.exec)
  assert.equal(s.name, 'nest_fix-the-tests')
  // Claude exited; a bare shell's title means nothing.
  s.command = 'bash'
  await mirrorTitles(await listWindows(tmux.exec, 'host'), tmux.exec)
  assert.equal(s.name, 'nest_fix-the-tests')
})

test('mirrorTitles leaves a session alone when tmux refuses the rename', async () => {
  const tmux = fakeTmux()
  tmux.add('bash', { title: 'Something', command: 'claude' })
  const failing = async (cmd: string, args: string[]) => {
    if (args[0] === 'rename-session') throw new Error('tmux went away')
    return tmux.exec(cmd, args)
  }
  const windows = await listWindows(failing, 'host')
  assert.deepEqual((await mirrorTitles(windows, failing)).map((w) => w.name), ['bash'])
})

test('listWindowSessions maps window ids to current session names', async () => {
  const tmux = fakeTmux()
  tmux.add('one')
  tmux.add('two')
  assert.deepEqual([...(await listWindowSessions(tmux.exec))], [['@0', 'nest_one'], ['@1', 'nest_two']])
  const noServer = async () => {
    throw Object.assign(new Error('no server running on /tmp/tmux'), { stderr: 'no server running on /tmp/tmux' })
  }
  assert.deepEqual([...(await listWindowSessions(noServer))], [])
})

test('unmarkNamed clears the named stamp', async () => {
  const tmux = fakeTmux()
  const s = tmux.add('x', { named: true })
  await unmarkNamed(s.id, tmux.exec)
  assert.equal(s.named, false)
  assert.deepEqual(tmux.calls.at(-1), ['set', '-u', '-t', '$0', '@nest_named'])
})
