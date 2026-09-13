// Version handshake, client side: build-id parsing, the drift notice, and
// the deploy its "sync now" runs.
//
// Run with: npx tsx --test src/__tests__/version.test.ts

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { commitOf, readBuildIdFromHtml } from '../shared/build.ts'
import {
  SYNC_SESSION,
  VERSION_ACTION_IDS,
  VERSION_NOTICE_KINDS,
  holdsSyncSession,
  planSync,
  readPageBuild,
  versionNotice,
  type VersionNotice,
  type VersionNoticeKind,
} from '../version.ts'

const HELLO_SAME = { serverBuild: 'abc1234', clientBuild: 'abc1234.kx9q2' }

test('readBuildIdFromHtml finds the meta tag vite injects', () => {
  const html = '<!doctype html><html><head><meta charset="UTF-8" />\n    <meta name="foray-build" content="abc1234-dirty.kx9q2"></head></html>'
  assert.equal(readBuildIdFromHtml(html), 'abc1234-dirty.kx9q2')
})

test('readBuildIdFromHtml is null for a page without one, or an empty one', () => {
  assert.equal(readBuildIdFromHtml('<html><head><title>Foray</title></head></html>'), null)
  assert.equal(readBuildIdFromHtml('<meta name="foray-build" content="">'), null)
})

test('commitOf strips the per-build timestamp', () => {
  assert.equal(commitOf('abc1234-dirty.kx9q2'), 'abc1234-dirty')
  assert.equal(commitOf('abc1234'), 'abc1234')
  assert.equal(commitOf('unknown.kx9q2'), 'unknown')
})

test('readPageBuild reads the meta tag from a document, null without one', () => {
  const doc = {
    querySelector: (selector: string) =>
      selector === 'meta[name="foray-build"]'
        ? { getAttribute: (name: string) => (name === 'content' ? 'abc1234.kx9q2' : null) }
        : null,
  } as unknown as Pick<Document, 'querySelector'>
  assert.equal(readPageBuild(doc), 'abc1234.kx9q2')
  assert.equal(readPageBuild({ querySelector: () => null } as unknown as Pick<Document, 'querySelector'>), null)
  assert.equal(readPageBuild(undefined), null)
})

test('no notice when the page matches both the bundle on disk and the server commit', () => {
  assert.equal(versionNotice('abc1234.kx9q2', HELLO_SAME, true), null)
})

test('stale page: the bundle on disk is a different build, so a reload fixes it', () => {
  const notice = versionNotice('abc1234.kx9q2', { serverBuild: 'abc1234', clientBuild: 'abc1234.lz0r3' }, true)
  assert.equal(notice?.kind, 'stale-page')
})

test('stale page wins over server drift, because it is the one the user can fix', () => {
  const notice = versionNotice('old0000.a', { serverBuild: 'new1111', clientBuild: 'new1111.b' }, true)
  assert.equal(notice?.kind, 'stale-page')
})

test('server drift: the server started from a different commit than the page was built from', () => {
  const notice = versionNotice('abc1234-dirty.kx9q2', { serverBuild: 'def5678', clientBuild: 'abc1234-dirty.kx9q2' }, true)
  assert.equal(notice?.kind, 'server-drift')
  assert.ok(notice?.text.includes('def5678') && notice?.text.includes('abc1234-dirty'), notice?.text)
})

test('a dirty page against a clean server at the same sha counts as drift', () => {
  const notice = versionNotice('abc1234-dirty.kx9q2', { serverBuild: 'abc1234', clientBuild: 'abc1234-dirty.kx9q2' }, true)
  assert.equal(notice?.kind, 'server-drift')
})

test('nothing to compare: dev pages, pages without a build, unknown commits', () => {
  assert.equal(versionNotice('abc1234.kx9q2', { serverBuild: 'def5678', clientBuild: 'zzz.1' }, false), null)
  assert.equal(versionNotice(null, { serverBuild: 'def5678', clientBuild: 'zzz.1' }, true), null)
  assert.equal(versionNotice('unknown.kx9q2', { serverBuild: 'def5678', clientBuild: 'unknown.kx9q2' }, true), null)
  assert.equal(versionNotice('abc1234.kx9q2', { serverBuild: 'unknown', clientBuild: 'abc1234.kx9q2' }, true), null)
  assert.equal(versionNotice('abc1234.kx9q2', { serverBuild: 'abc1234', clientBuild: null }, true), null)
})

// --- every notice can be acted on -----------------------------------------
//
// The compiler is what actually guarantees this: VersionNotice requires an
// `action`, its id must be a VersionActionId, and VersionBanner takes a
// handler for every id, so a kind that renders a dead end cannot be
// written. This walks the kinds anyway, because a dead-end banner is the
// bug that started all of it: a drift notice that said "Rebuild and
// restart Foray to sync" with nothing to click.

/** One set of inputs per kind. A new kind fails to compile until it has one. */
const PRODUCES: Record<VersionNoticeKind, () => VersionNotice | null> = {
  'stale-page': () => versionNotice('abc1234.kx9q2', { serverBuild: 'abc1234', clientBuild: 'abc1234.lz0r3' }, true),
  'server-drift': () =>
    versionNotice('abc1234.kx9q2', { serverBuild: 'def5678', clientBuild: 'abc1234.kx9q2' }, true),
}

test('every notice kind comes with an action the banner can render', () => {
  for (const kind of VERSION_NOTICE_KINDS) {
    const notice = PRODUCES[kind]()
    assert.ok(notice, `no inputs produce a ${kind} notice`)
    assert.equal(notice.kind, kind)
    assert.ok(notice.text.length > 0, `${kind} has no text`)
    assert.ok(notice.action.label.length > 0, `${kind}'s action has no label`)
    assert.ok(VERSION_ACTION_IDS.includes(notice.action.id), `${kind}'s action id is not one VersionBanner handles`)
  }
})

test('a reload fixes a stale page; only a deploy fixes server drift', () => {
  assert.equal(PRODUCES['stale-page']()?.action.id, 'reload')
  assert.equal(PRODUCES['server-drift']()?.action.id, 'sync')
})

test('the drift text says which side is behind, and names both builds', () => {
  const text = PRODUCES['server-drift']()?.text ?? ''
  assert.ok(text.includes('def5678') && text.includes('abc1234'), text)
  assert.ok(/server/i.test(text), text)
})

// --- what "sync now" does --------------------------------------------------

const SESSIONS = [
  { id: 1, name: 'bash' },
  { id: 2, name: 'claude' },
]

test('sync creates the deploy session in the directory the server runs from', () => {
  assert.deepEqual(planSync(SESSIONS, '/home/me/foray'), {
    kind: 'create',
    name: SYNC_SESSION,
    cwd: '/home/me/foray',
  })
})

test('sync still creates one when the server did not say where it runs', () => {
  assert.deepEqual(planSync(SESSIONS, null), { kind: 'create', name: SYNC_SESSION, cwd: null })
})

test('a deploy session already there is the lock: focus it, start nothing', () => {
  const running = [...SESSIONS, { id: 7, name: SYNC_SESSION }]
  assert.deepEqual(planSync(running, '/home/me/foray'), { kind: 'focus', windowId: 7 })
})

test('only the session that got the name runs the deploy; a -1 means someone beat us to it', () => {
  assert.equal(holdsSyncSession({ name: SYNC_SESSION }), true)
  assert.equal(holdsSyncSession({ name: `${SYNC_SESSION}-1` }), false)
  assert.equal(holdsSyncSession({ name: 'bash' }), false)
})
