// URL helpers for the terminal link chip and history links.
//
// Run with: npx tsx src/__tests__/links.test.ts
//
// Covers:
//  1. extractUrls: http/https only, several per line, dedupe in first-seen
//     order, trailing punctuation and quotes stripped, a trailing `)` kept
//     only when it balances one inside the URL, bare scheme is not a URL
//  2. shortenUrl: scheme dropped, short URLs intact, long ones middle-
//     ellipsised to at most `max` characters
//  3. joinWrapped: wrapped rows re-join their logical line; others stay put

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { extractUrls, extractCommands, shortenUrl, shortenCommand, joinWrapped } from '../links.ts'

// ---------------------------------------------------------------------------
// extractUrls
// ---------------------------------------------------------------------------

test('extractUrls: finds http and https URLs', () => {
  assert.deepEqual(extractUrls('go to http://a.b/c now'), ['http://a.b/c'])
  assert.deepEqual(extractUrls('go to https://a.b/c now'), ['https://a.b/c'])
})

test('extractUrls: several URLs on one line, in order', () => {
  assert.deepEqual(
    extractUrls('first https://one.example/x then https://two.example/y'),
    ['https://one.example/x', 'https://two.example/y'],
  )
})

test('extractUrls: dedupes while preserving first-occurrence order', () => {
  assert.deepEqual(
    extractUrls('https://b.example/1 https://a.example/2 https://b.example/1 https://a.example/2'),
    ['https://b.example/1', 'https://a.example/2'],
  )
})

test('extractUrls: strips trailing period, comma and quotes', () => {
  assert.deepEqual(extractUrls('Open https://a.b/c.'), ['https://a.b/c'])
  assert.deepEqual(extractUrls('Open https://a.b/c, then'), ['https://a.b/c'])
  assert.deepEqual(extractUrls(`Open "https://a.b/c"`), ['https://a.b/c'])
  assert.deepEqual(extractUrls(`Open 'https://a.b/c'`), ['https://a.b/c'])
  assert.deepEqual(extractUrls('Ready? https://a.b/c!'), ['https://a.b/c'])
  assert.deepEqual(extractUrls('Then: https://a.b/c; done'), ['https://a.b/c'])
})

test('extractUrls: keeps a balanced trailing paren, drops an unbalanced one', () => {
  assert.deepEqual(
    extractUrls('see https://en.wikipedia.org/wiki/Foo_(bar) for details'),
    ['https://en.wikipedia.org/wiki/Foo_(bar)'],
  )
  assert.deepEqual(extractUrls('(see https://a.b/c)'), ['https://a.b/c'])
})

test('extractUrls: a bare scheme is not a URL', () => {
  assert.deepEqual(extractUrls('the prefix https:// alone'), [])
  assert.deepEqual(extractUrls('http://'), [])
})

test('extractUrls: no URLs gives an empty list', () => {
  assert.deepEqual(extractUrls('nothing to see here'), [])
  assert.deepEqual(extractUrls(''), [])
})

// ---------------------------------------------------------------------------
// shortenUrl
// ---------------------------------------------------------------------------

test('shortenUrl: drops the scheme and keeps a short URL whole', () => {
  assert.equal(shortenUrl('https://example.com/a/b'), 'example.com/a/b')
  assert.equal(shortenUrl('http://example.com/a/b'), 'example.com/a/b')
})

test('shortenUrl: a long URL is middle-ellipsised to at most max', () => {
  const long = 'https://example.com/app/auth/cli/abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ'
  const out = shortenUrl(long)
  assert.ok(out.length <= 40, `expected <= 40 chars, got ${out.length}: ${out}`)
  assert.ok(out.includes('…'), `expected an ellipsis in ${out}`)
  assert.ok(out.startsWith('example.com'), `expected host first in ${out}`)
  assert.ok(!out.includes('https://'), 'scheme should be dropped')
})

test('shortenUrl: honours a custom max', () => {
  const long = 'https://example.com/some/rather/long/path/that/keeps/going'
  const out = shortenUrl(long, 20)
  assert.ok(out.length <= 20, `expected <= 20 chars, got ${out.length}: ${out}`)
  assert.ok(out.includes('…'))
})

test('shortenUrl: a URL exactly at max is returned whole', () => {
  const body = 'example.com/' + 'x'.repeat(40 - 'example.com/'.length)
  assert.equal(body.length, 40)
  assert.equal(shortenUrl(`https://${body}`), body)
})

// ---------------------------------------------------------------------------
// joinWrapped
// ---------------------------------------------------------------------------

test('joinWrapped: a three-row wrap becomes one logical line', () => {
  const rows = [
    { text: 'Opening https://example.com/app/auth/', wrapped: false },
    { text: 'cli/abcdefghijklmnopqrstuvwxyz0123456789', wrapped: true },
    { text: 'ABCDEFGHIJ for login', wrapped: true },
  ]
  assert.deepEqual(joinWrapped(rows), [
    'Opening https://example.com/app/auth/cli/abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJ for login',
  ])
})

test('joinWrapped: unwrapped rows stay separate', () => {
  const rows = [
    { text: 'one', wrapped: false },
    { text: 'two', wrapped: false },
    { text: 'three', wrapped: false },
  ]
  assert.deepEqual(joinWrapped(rows), ['one', 'two', 'three'])
})

test('joinWrapped: wraps join only to their own line', () => {
  const rows = [
    { text: 'alpha-', wrapped: false },
    { text: 'beta', wrapped: true },
    { text: 'gamma', wrapped: false },
    { text: 'delta-', wrapped: false },
    { text: 'epsilon', wrapped: true },
  ]
  assert.deepEqual(joinWrapped(rows), ['alpha-beta', 'gamma', 'delta-epsilon'])
})

test('joinWrapped: empty input gives an empty list', () => {
  assert.deepEqual(joinWrapped([]), [])
})

// ---------------------------------------------------------------------------
// extractCommands
// ---------------------------------------------------------------------------

test('extractCommands: detects common CLI tools', () => {
  assert.deepEqual(extractCommands('claude --resume abc-123'), ['claude --resume abc-123'])
  assert.deepEqual(extractCommands('git push origin main'), ['git push origin main'])
  assert.deepEqual(extractCommands('npm install'), ['npm install'])
})

test('extractCommands: strips $ prompt prefix', () => {
  assert.deepEqual(extractCommands('$ claude --resume abc-123'), ['claude --resume abc-123'])
  assert.deepEqual(extractCommands('$ git status'), ['git status'])
})

test('extractCommands: ignores tool name alone (no args)', () => {
  assert.deepEqual(extractCommands('git'), [])
  assert.deepEqual(extractCommands('npm'), [])
})

test('extractCommands: multiple commands, deduped', () => {
  const text = 'git push origin main\nnpm install\ngit push origin main'
  assert.deepEqual(extractCommands(text), ['git push origin main', 'npm install'])
})

test('extractCommands: ignores non-command lines', () => {
  assert.deepEqual(extractCommands('nothing to see here'), [])
  assert.deepEqual(extractCommands('the git repository is fine'), [])
})

test('extractCommands: command in the middle of prose is not matched', () => {
  assert.deepEqual(extractCommands('run git push to deploy'), [])
})

// ---------------------------------------------------------------------------
// shortenCommand
// ---------------------------------------------------------------------------

test('shortenCommand: short command returned whole', () => {
  assert.equal(shortenCommand('git push'), 'git push')
})

test('shortenCommand: long command is truncated with ellipsis', () => {
  const long = 'claude --resume 52040212-6482-422c-a8e6-324df93ab7d1-extra-long-id-here'
  const out = shortenCommand(long, 50)
  assert.ok(out.length <= 50, `expected <= 50 chars, got ${out.length}`)
  assert.ok(out.endsWith('…'))
})
