// URL helpers for history links, and the row joiner select mode relies on.
//
// Run with: npx tsx src/__tests__/links.test.ts
//
// Covers:
//  1. URL_RE + cleanUrl: http/https only, several per line, trailing
//     punctuation and quotes stripped, a trailing `)` kept only when it
//     balances one inside the URL, bare scheme is not a URL
//  2. joinWrapped: wrapped rows re-join their logical line; others stay put

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { URL_RE, cleanUrl, joinWrapped } from '../links.ts'

/** What the link chip used to do; kept as the spec for URL_RE + cleanUrl. */
function extractUrls(text: string): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const m of text.matchAll(URL_RE)) {
    const url = cleanUrl(m[0])
    if (!url || seen.has(url)) continue
    seen.add(url)
    out.push(url)
  }
  return out
}

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
