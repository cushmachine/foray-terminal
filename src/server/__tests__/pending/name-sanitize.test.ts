// Pending for S4 (sessionNameFor shared by create and rename).
//
// tmux rejects '.' and ':' in session names. renameWindow replaces them,
// createWindow does not: creating a session named "v1.2" fails against
// real tmux while renaming to "v1.2" works. Both must go through one
// sanitiser and produce the same tmux name for the same input.
//
// Run with: npx tsx --test src/server/__tests__/pending/name-sanitize.test.ts

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createWindow, renameWindow } from '../../tmux.ts'
import { fakeTmux } from '../helpers.ts'

test('create and rename produce the same tmux session name for the same input', async () => {
  const tmux = fakeTmux()
  const created = await createWindow('a.b:c', undefined, tmux.exec)
  await renameWindow(created.id, 'a.b:c', tmux.exec)

  const newSession = tmux.calls.find((args) => args[0] === 'new-session')
  const rename = tmux.calls.find((args) => args[0] === 'rename-session')
  assert.ok(newSession && rename)
  const createdName = newSession[newSession.indexOf('-s') + 1]
  const renamedName = rename[rename.length - 1]
  assert.equal(createdName, renamedName)
  assert.doesNotMatch(createdName, /[.:]/, 'tmux would reject this name')
})
