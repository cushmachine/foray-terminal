// Pending for S5 (the create flag becomes a pure helper; clears on error).
//
// App remembers that this client asked for a session so that only it, not
// every other device, switches to the one that arrives. If the create
// fails the flag stays set today, and the next session anyone else creates
// yanks this device into it. Expected in src/sessionState.ts:
//
//   export function pendingCreateAfter(pending: boolean, msg: ServerMessage): boolean
//
// session:created and an error whose `request` is 'session:create' clear
// it; everything else leaves it alone. (`request` on ErrorMessage lands in
// S4; until then the helper clears on any error.)
//
// Run with: npx tsx --test src/__tests__/pending/pending-create-clears-on-error.test.ts

import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ServerMessage, TmuxWindow } from '../../shared/protocol.ts'

type PendingCreateAfter = (pending: boolean, msg: ServerMessage) => boolean

/** The helper as S5 will export it; today the import has no such member. */
async function loadHelper(): Promise<PendingCreateAfter> {
  const mod = (await import('../../sessionState.ts')) as unknown as { pendingCreateAfter?: PendingCreateAfter }
  if (!mod.pendingCreateAfter) throw new Error('sessionState.ts does not export pendingCreateAfter yet')
  return mod.pendingCreateAfter
}

const window: TmuxWindow = { id: 3, name: 'bash', cwd: '/root', title: '', command: 'bash', named: false }

test('the create flag clears on an error answering session:create', async () => {
  const pendingCreateAfter = await loadHelper()
  const failed = { type: 'error', message: 'tmux said no', request: 'session:create' } as ServerMessage
  assert.equal(pendingCreateAfter(true, failed), false)
})

test('the create flag clears when the session arrives and survives unrelated messages', async () => {
  const pendingCreateAfter = await loadHelper()
  assert.equal(pendingCreateAfter(true, { type: 'session:created', window }), false)
  assert.equal(pendingCreateAfter(true, { type: 'session:renamed', windowId: 1, name: 'x' }), true)
  assert.equal(pendingCreateAfter(false, { type: 'session:created', window }), false)
})
