// Version handshake, client side: build-id parsing and the drift notice.
//
// Run with: npx tsx --test src/__tests__/version.test.ts

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { commitOf, readBuildIdFromHtml } from '../shared/build.ts'
import { readPageBuild, versionNotice } from '../version.ts'

const HELLO_SAME = { serverBuild: 'abc1234', clientBuild: 'abc1234.kx9q2' }

test('readBuildIdFromHtml finds the meta tag vite injects', () => {
  const html = '<!doctype html><html><head><meta charset="UTF-8" />\n    <meta name="nest-build" content="abc1234-dirty.kx9q2"></head></html>'
  assert.equal(readBuildIdFromHtml(html), 'abc1234-dirty.kx9q2')
})

test('readBuildIdFromHtml is null for a page without one, or an empty one', () => {
  assert.equal(readBuildIdFromHtml('<html><head><title>Foray</title></head></html>'), null)
  assert.equal(readBuildIdFromHtml('<meta name="nest-build" content="">'), null)
})

test('commitOf strips the per-build timestamp', () => {
  assert.equal(commitOf('abc1234-dirty.kx9q2'), 'abc1234-dirty')
  assert.equal(commitOf('abc1234'), 'abc1234')
  assert.equal(commitOf('unknown.kx9q2'), 'unknown')
})

test('readPageBuild reads the meta tag from a document, null without one', () => {
  const doc = {
    querySelector: (selector: string) =>
      selector === 'meta[name="nest-build"]'
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
