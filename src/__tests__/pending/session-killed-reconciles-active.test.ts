// Pending for S5 (session:killed reconciles the active session at once).
//
// When the active session is killed, App keeps pointing at the dead id
// until the next 2 s poll's session:list picks a new one; the terminal
// area is blank meanwhile. The choice is a pure function, expected in
// src/sessionState.ts:
//
//   export function nextActiveAfterKill(
//     sessions: Session[], active: number | null, killedId: number,
//   ): number | null
//
// `sessions` is the list before the kill. Killing a session other than
// the active one changes nothing; killing the active one picks another
// session that still exists (a neighbour in creation order); killing the
// last session yields null.
//
// Run with: npx tsx --test src/__tests__/pending/session-killed-reconciles-active.test.ts

import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Session } from '../../sessionState.ts'

type NextActiveAfterKill = (sessions: Session[], active: number | null, killedId: number) => number | null

/** The helper as S5 will export it; today the import has no such member. */
async function loadHelper(): Promise<NextActiveAfterKill> {
  const mod = (await import('../../sessionState.ts')) as unknown as { nextActiveAfterKill?: NextActiveAfterKill }
  if (!mod.nextActiveAfterKill) throw new Error('sessionState.ts does not export nextActiveAfterKill yet')
  return mod.nextActiveAfterKill
}

function session(id: number): Session {
  return { id, name: `s${id}`, cwd: '/root', title: '', command: 'bash', named: false }
}

const sessions = [session(1), session(2), session(3)]

test('killing another session leaves the active one alone', async () => {
  const nextActiveAfterKill = await loadHelper()
  assert.equal(nextActiveAfterKill(sessions, 2, 3), 2)
})

test('killing the active session picks a surviving one immediately', async () => {
  const nextActiveAfterKill = await loadHelper()
  const next = nextActiveAfterKill(sessions, 2, 2)
  assert.notEqual(next, 2)
  assert.ok(next !== null && sessions.some((s) => s.id === next), `picked ${next}, which does not exist`)
})

test('killing the last session leaves nothing active', async () => {
  const nextActiveAfterKill = await loadHelper()
  assert.equal(nextActiveAfterKill([session(1)], 1, 1), null)
})
