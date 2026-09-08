// sortSessions: natural order so bash-2 sorts before bash-10.
//
// Run with: npx tsx --test src/__tests__/sessions-sort.test.ts

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sortSessions, type Session } from '../sessionState.ts'

const session = (id: number, name: string): Session =>
  ({ id, name, cwd: '/root', title: '', command: 'bash', named: false })

test('#4 sortSessions orders by id, which is creation order, not by name', () => {
  const input = [session(10, 'bash-10'), session(2, 'bash-2'), session(1, 'bash-1')]
  const sorted = sortSessions(input)
  assert.deepEqual(sorted.map((s) => s.id), [1, 2, 10])
  // Pure: the input is untouched and a new array comes back.
  assert.deepEqual(input.map((s) => s.id), [10, 2, 1])
  assert.notEqual(sorted, input)
})

test('#4 sortSessions is stable for an already ordered list', () => {
  const input = [session(1, 'a'), session(2, 'b')]
  assert.deepEqual(sortSessions(input).map((s) => s.id), [1, 2])
})

