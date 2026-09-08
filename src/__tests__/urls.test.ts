// URL helpers shared by history links and the live screen's link addon.
//
// Run with: npx tsx --test src/__tests__/urls.test.ts
//
// Covers URL_RE + cleanUrl: http/https only, several per line, trailing
// punctuation and quotes stripped, a trailing `)` kept only when it
// balances one inside the URL, bare scheme is not a URL.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { URL_RE, cleanUrl } from '../urls.ts'

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
