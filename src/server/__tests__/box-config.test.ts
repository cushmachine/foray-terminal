// The per-box label and palette (server/boxConfig.ts): parsing, the
// derived accent colours, what reaches index.html and manifest.json.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import {
  PALETTE_KEYS, applyBoxConfigToHtml, applyBoxConfigToManifest, loadBoxConfig, parseBoxConfig, isSafeColor,
} from '../boxConfig.ts'
import { startTestServer, tmpDir } from './helpers.ts'

function parse(data: unknown) {
  const warnings: string[] = []
  return { config: parseBoxConfig(data, (m) => warnings.push(m)), warnings }
}

test('a good config: label trimmed, accent kept, the rest derived', () => {
  const { config, warnings } = parse({ label: '  Studio ', palette: { accent: '#d4a72c' } })
  assert.deepEqual(warnings, [])
  assert.equal(config.label, 'Studio')
  assert.equal(config.palette['accent'], '#d4a72c')
  assert.match(config.palette['accent-dim']!, /^#[0-9a-f]{6}$/)
  assert.match(config.palette['accent-text']!, /^#[0-9a-f]{6}$/)
  assert.equal(config.palette['term-selection'], '#d4a72c33')
})

test('derivation mirrors the teal defaults and respects explicit values', () => {
  const { config } = parse({ palette: { accent: '#3db8a9', 'accent-dim': '#111111' } })
  assert.equal(config.palette['accent-dim'], '#111111')
  assert.equal(config.palette['accent-text'], '#64c6ba')
  assert.equal(config.palette['term-selection'], '#3db8a933')
  const { config: rgb } = parse({ palette: { accent: 'rgb(61, 184, 169)' } })
  assert.equal(rgb.palette['term-selection'], '#3db8a933')
  assert.equal(parse({ palette: { text: '#fff' } }).config.palette['accent-dim'], undefined)
})

test('unknown keys and bad values are dropped with a warning, never thrown', () => {
  const { config, warnings } = parse({
    label: 'x', color: 'red', palette: { accent: 'red', bg: 'url(http://x)', nope: '#fff', surface: '#12345', text: '#fff' },
  })
  assert.deepEqual(config.palette, { text: '#fff' })
  assert.equal(warnings.length, 5)
  for (const w of warnings) assert.ok(!w.includes('\n'))
})

test('colour validation is strict', () => {
  for (const ok of ['#fff', '#ffff', '#ffffff', '#ffffff80', 'rgb(0,0,0)', 'rgba(255, 255, 255, 0.5)', 'rgba(1,2,3,.5)']) assert.ok(isSafeColor(ok), ok)
  for (const bad of ['red', '#ggg', '#fffff', 'rgb(256,0,0)', 'rgb(0,0,0);}</style><script>', '#fff;}body{x:y', 'var(--accent)', 'rgb(0,0,0) !important', 5, null, '#fff\n']) {
    assert.ok(!isSafeColor(bad), String(bad))
  }
})

test('label: plain text, capped, control characters removed, non-strings ignored', () => {
  assert.equal(parse({ label: 'a'.repeat(60) }).config.label?.length, 24)
  assert.equal(parse({ label: 'a\nb\u0000c' }).config.label, 'a b c')
  assert.equal(parse({ label: '   ' }).config.label, undefined)
  assert.equal(parse({ label: 7 }).config.label, undefined)
  assert.equal(parse(['x']).config.label, undefined)
  assert.equal(parse(null).warnings.length, 1)
})

test('loadBoxConfig: missing is null and silent, bad JSON warns, good parses', async () => {
  const dir = await tmpDir('foray-box-')
  try {
    const lines: string[] = []
    const logger = { log: (...a: unknown[]) => lines.push(a.join(' ')) }
    assert.equal(loadBoxConfig(path.join(dir, 'none.json'), logger), null)
    assert.deepEqual(lines, [])
    const bad = path.join(dir, 'bad.json')
    await fs.writeFile(bad, '{ nope')
    assert.equal(loadBoxConfig(bad, logger), null)
    assert.equal(lines.length, 1)
    const good = path.join(dir, 'good.json')
    await fs.writeFile(good, JSON.stringify({ label: 'Nest' }))
    assert.equal(loadBoxConfig(good, logger)?.label, 'Nest')
    await fs.writeFile(good, '{}')
    assert.equal(loadBoxConfig(good, logger), null)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

const HTML =
  '<!doctype html><html><head><meta name="apple-mobile-web-app-title" content="Foray" />' +
  '<meta name="theme-color" content="#0a0a0c" /><title>Foray</title></head><body></body></html>'

test('index.html: title, theme colour, style and label meta; label is escaped', () => {
  const { config } = parse({ label: `<b a="1">&'`, palette: { accent: '#d4a72c' } })
  const html = applyBoxConfigToHtml(HTML, config)
  assert.ok(html.includes('<meta name="theme-color" content="#d4a72c" />'))
  assert.ok(html.includes('--accent:#d4a72c;'))
  assert.ok(html.includes('<style id="foray-box-palette">:root{'))
  assert.ok(!html.includes('<b a'))
  assert.ok(html.includes('&lt;b a=&quot;1&quot;&gt;&amp;&#39;'))
  assert.match(html, /<title>Foray · &lt;b/)
})

test('index.html: label only leaves colours alone; a `$&` label stays literal', () => {
  const html = applyBoxConfigToHtml(HTML, parse({ label: '$& $1' }).config)
  assert.ok(html.includes('content="#0a0a0c"'))
  assert.ok(!html.includes('<style'))
  assert.ok(html.includes('<title>Foray · $&amp; $1</title>'))
})

test('manifest: names and theme colour; short name fits 12 or falls back to the label', () => {
  const base = { name: 'Foray', short_name: 'Foray', theme_color: '#0a0a0c', icons: [] }
  const m = applyBoxConfigToManifest(base, parse({ label: 'Studio', palette: { accent: '#d4a72c' } }).config)
  assert.deepEqual(m, { name: 'Foray · Studio', short_name: 'Foray Studio', theme_color: '#d4a72c', icons: [] })
  assert.equal(applyBoxConfigToManifest(base, parse({ label: 'Mac Studio Box' }).config).short_name, 'Mac Studio Box')
  assert.equal(applyBoxConfigToManifest(base, parse({ label: 'Nest' }).config).short_name, 'Foray Nest')
  assert.equal(applyBoxConfigToManifest(base, parse({ palette: { text: '#fff' } }).config).name, 'Foray')
})

test('every palette key is a colour token in styles.css, and every colour token is listed', async () => {
  const css = await fs.readFile(path.join(import.meta.dirname, '../../styles.css'), 'utf8')
  const root = css.slice(css.indexOf(':root {'), css.indexOf('\n}', css.indexOf(':root {')))
  const tokens = [...root.matchAll(/--([a-z-]+):\s*([^;]+);/g)]
  const colours = tokens.filter(([, , v]) => /^(#|rgba?\(|var\(--)/.test(v!.trim())).map(([, k]) => k!)
  for (const key of PALETTE_KEYS) assert.ok(colours.includes(key), `${key} is not a colour token`)
  for (const key of colours) assert.ok(PALETTE_KEYS.includes(key), `${key} is missing from PALETTE_KEYS`)
})

test('the server serves the labelled index and manifest, and the plain ones without config', async () => {
  const root = await tmpDir('foray-box-dist-')
  const dist = path.join(root, 'dist')
  await fs.mkdir(dist, { recursive: true })
  await fs.writeFile(path.join(dist, 'index.html'), HTML)
  await fs.writeFile(path.join(dist, 'manifest.json'), JSON.stringify({ name: 'Foray', short_name: 'Foray', theme_color: '#0a0a0c' }))
  const boxConfig = parse({ label: 'Studio', palette: { accent: '#d4a72c' } }).config
  const labelled = await startTestServer({ clientDist: dist, boxConfig })
  const plain = await startTestServer({ clientDist: dist })
  try {
    for (const route of ['/', '/some/route']) {
      const res = await fetch(`${labelled.url}${route}`)
      assert.equal(res.headers.get('cache-control'), 'no-cache')
      assert.match(await res.text(), /<title>Foray · Studio<\/title>/)
    }
    const res = await fetch(`${labelled.url}/manifest.json`)
    assert.equal(res.headers.get('cache-control'), 'no-cache')
    const m = await res.json()
    assert.equal(m.name, 'Foray · Studio')
    assert.equal(m.theme_color, '#d4a72c')

    assert.equal(await (await fetch(`${plain.url}/`)).text(), HTML)
    assert.equal((await (await fetch(`${plain.url}/manifest.json`)).json()).name, 'Foray')
  } finally {
    await labelled.close()
    await plain.close()
    await fs.rm(root, { recursive: true, force: true })
  }
})
