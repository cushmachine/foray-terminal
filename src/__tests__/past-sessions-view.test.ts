// Pure helpers behind the sidebar's past-sessions section.
//
// Run with: npx tsx --test src/__tests__/past-sessions-view.test.ts

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { relativeTime, showsAgent, visiblePast } from '../pastSessionsView.ts'
import type { PastSession } from '../shared/protocol.ts'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

test('relativeTime rounds down to the largest fitting unit', () => {
  const now = Date.UTC(2026, 8, 9, 12, 0, 0)
  assert.equal(relativeTime(now, now), 'just now')
  assert.equal(relativeTime(now - 30_000, now), 'just now')
  assert.equal(relativeTime(now - 5 * MINUTE, now), '5m')
  assert.equal(relativeTime(now - 3 * HOUR - 20 * MINUTE, now), '3h')
  assert.equal(relativeTime(now - 2 * DAY, now), '2d')
  assert.equal(relativeTime(now - 21 * DAY, now), '3w')
  // A future timestamp (clock skew) is not negative.
  assert.equal(relativeTime(now + HOUR, now), 'just now')
})

test('relativeTime falls back to a date beyond five weeks', () => {
  const now = Date.UTC(2026, 8, 9, 12, 0, 0)
  const then = new Date(2026, 6, 4, 12)
  assert.equal(relativeTime(then.getTime(), now), 'Jul 4')
})

test('visiblePast caps the list until expanded', () => {
  const list = Array.from({ length: 20 }, (_, i) => i)
  assert.deepEqual(visiblePast(list, false, 15), { shown: list.slice(0, 15), hidden: 5 })
  assert.deepEqual(visiblePast(list, true, 15), { shown: list, hidden: 0 })
  assert.deepEqual(visiblePast(list.slice(0, 3), false, 15), { shown: [0, 1, 2], hidden: 0 })
  assert.deepEqual(visiblePast([], false), { shown: [], hidden: 0 })
})

const row = (agent: string): PastSession =>
  ({ agent, agentLabel: agent, id: 'x', title: 't', lastPrompt: '', cwd: '/', branch: '', lastActive: 0, live: false })

test('showsAgent only when more than one agent is present', () => {
  assert.equal(showsAgent([]), false)
  assert.equal(showsAgent([row('claude'), row('claude')]), false)
  assert.equal(showsAgent([row('claude'), row('codex')]), true)
})
