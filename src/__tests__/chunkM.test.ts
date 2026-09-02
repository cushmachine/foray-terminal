// Chunk M tests: mobile optimization (see MOBILE-PLAN.md).
//
// Run with: npm run test:chunkM
// (executed directly via `tsx`, using node's built-in test runner)
//
// Covers the pure, DOM-free pieces of the mobile work:
//  M1. terminal sizing (fit gating, resize dedupe), visual-viewport height,
//      and lazy terminal mounting
//  M2. mobile viewport detection, sidebar edge swipes, persisted font size
//  M3. key toolbar vocabulary, sticky Ctrl/Alt, hold-to-repeat timing
//  M4. PWA manifest and icons (real PNG dimensions), service worker policy

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import vm from 'node:vm'

import { canFit, nextResize } from '../terminalSize.ts'
import { appHeight } from '../hooks/useAppHeight.ts'
import { openedWith } from '../sessionState.ts'
import {
  NO_MODIFIERS,
  PRIMARY_KEYS,
  REPEAT_INITIAL_MS,
  REPEAT_INTERVAL_MS,
  SECONDARY_KEYS,
  applyModifiers,
  repeatDelay,
} from '../keys.ts'
import {
  MOBILE_MEDIA_QUERY,
  clampFontSize,
  defaultFontSize,
  isMobileViewport,
  readFontSize,
  swipeAction,
} from '../mobile.ts'

// ---------------------------------------------------------------------------
// M1: terminal sizing
// ---------------------------------------------------------------------------

test('canFit: false while the container has no size (display: none)', () => {
  assert.equal(canFit(0, 0), false)
  assert.equal(canFit(0, 400), false)
  assert.equal(canFit(390, 0), false)
  assert.equal(canFit(390, 600), true)
})

test('nextResize: first size is always reported', () => {
  assert.deepEqual(nextResize(null, 80, 24), { cols: 80, rows: 24 })
})

test('nextResize: an unchanged size is not reported again', () => {
  assert.equal(nextResize({ cols: 80, rows: 24 }, 80, 24), null)
})

test('nextResize: a changed size is reported', () => {
  assert.deepEqual(nextResize({ cols: 80, rows: 24 }, 52, 30), { cols: 52, rows: 30 })
  assert.deepEqual(nextResize({ cols: 80, rows: 24 }, 80, 25), { cols: 80, rows: 25 })
})

test('nextResize: refuses nonsense sizes', () => {
  assert.equal(nextResize(null, NaN, 24), null)
  assert.equal(nextResize(null, 80, 0), null)
  assert.equal(nextResize(null, 80.5, 24), null)
})

// ---------------------------------------------------------------------------
// M1: visual viewport height
// ---------------------------------------------------------------------------

test('appHeight: uses the visual viewport when present and unzoomed', () => {
  assert.equal(appHeight({ height: 500.4, scale: 1 }, 844), 500)
})

test('appHeight: falls back without a visual viewport', () => {
  assert.equal(appHeight(null, 844), 844)
  assert.equal(appHeight(undefined, 844), 844)
})

test('appHeight: ignores a pinch-zoomed viewport', () => {
  assert.equal(appHeight({ height: 300, scale: 2 }, 844), 844)
})

test('appHeight: ignores a zero-height viewport', () => {
  assert.equal(appHeight({ height: 0, scale: 1 }, 844), 844)
})

// ---------------------------------------------------------------------------
// M1: lazy terminal mounting
// ---------------------------------------------------------------------------

test('openedWith: adds the active session once and keeps order', () => {
  const a = openedWith([], 3)
  assert.deepEqual(a, [3])
  const b = openedWith(a, 5)
  assert.deepEqual(b, [3, 5])
  assert.equal(openedWith(b, 3), b, 'a known id returns the same array')
})

test('openedWith: null (no active session) is a no-op', () => {
  const opened = [1]
  assert.equal(openedWith(opened, null), opened)
})

// ---------------------------------------------------------------------------
// M2: mobile detection, sidebar swipe, font size
// ---------------------------------------------------------------------------

test('isMobileViewport: phone portrait and landscape are mobile', () => {
  assert.equal(isMobileViewport({ width: 390, height: 844, coarse: true }), true)
  assert.equal(isMobileViewport({ width: 844, height: 390, coarse: true }), true)
})

test('isMobileViewport: tablets and desktops are not', () => {
  assert.equal(isMobileViewport({ width: 768, height: 1024, coarse: true }), false)
  assert.equal(isMobileViewport({ width: 1440, height: 900, coarse: false }), false)
})

test('isMobileViewport: a short desktop window with a mouse stays desktop', () => {
  assert.equal(isMobileViewport({ width: 1200, height: 480, coarse: false }), false)
})

test('MOBILE_MEDIA_QUERY encodes the same thresholds', () => {
  assert.ok(MOBILE_MEDIA_QUERY.includes('(max-width: 767px)'))
  assert.ok(MOBILE_MEDIA_QUERY.includes('(pointer: coarse)'))
  assert.ok(MOBILE_MEDIA_QUERY.includes('(max-height: 500px)'))
})

test('swipeAction: rightward swipe from the left edge opens a closed drawer', () => {
  assert.equal(swipeAction({ x: 10, y: 300 }, { x: 120, y: 310 }, false), 'open')
})

test('swipeAction: rightward swipe from mid-screen does nothing', () => {
  assert.equal(swipeAction({ x: 200, y: 300 }, { x: 320, y: 300 }, false), null)
})

test('swipeAction: leftward swipe anywhere closes an open drawer', () => {
  assert.equal(swipeAction({ x: 300, y: 300 }, { x: 180, y: 300 }, true), 'close')
})

test('swipeAction: short or mostly vertical gestures are ignored', () => {
  assert.equal(swipeAction({ x: 10, y: 300 }, { x: 40, y: 300 }, false), null)
  assert.equal(swipeAction({ x: 10, y: 100 }, { x: 80, y: 400 }, false), null)
  assert.equal(swipeAction({ x: 300, y: 100 }, { x: 200, y: 400 }, true), null)
})

test('defaultFontSize: smaller on phones', () => {
  assert.equal(defaultFontSize(true), 13)
  assert.equal(defaultFontSize(false), 14)
})

test('clampFontSize: keeps sizes within 10–22 and rounds', () => {
  assert.equal(clampFontSize(5), 10)
  assert.equal(clampFontSize(40), 22)
  assert.equal(clampFontSize(13.6), 14)
  assert.equal(clampFontSize(NaN), 10)
})

test('readFontSize: parses stored values and falls back on garbage', () => {
  assert.equal(readFontSize('16', 13), 16)
  assert.equal(readFontSize('99', 13), 22)
  assert.equal(readFontSize(null, 13), 13)
  assert.equal(readFontSize('', 13), 13)
  assert.equal(readFontSize('large', 13), 13)
})

// ---------------------------------------------------------------------------
// M3: key toolbar vocabulary and sticky modifiers
// ---------------------------------------------------------------------------

const allKeys = [...PRIMARY_KEYS, ...SECONDARY_KEYS]
const byId = (id: string) => {
  const key = allKeys.find(k => k.id === id)
  assert.ok(key, `missing key ${id}`)
  return key
}

test('keys: ids are unique across both rows', () => {
  const ids = allKeys.map(k => k.id)
  assert.equal(new Set(ids).size, ids.length)
})

test('keys: every plain key carries bytes; every action key carries none', () => {
  for (const key of allKeys) {
    if (key.kind === 'key') assert.ok(key.data && key.data.length > 0, `${key.id} has no data`)
    else assert.equal(key.data, undefined, `${key.id} should not carry data`)
  }
})

test('keys: the sequences Claude Code cares about', () => {
  assert.equal(byId('esc').data, '\x1b')
  assert.equal(byId('tab').data, '\t')
  assert.equal(byId('shift-tab').data, '\x1b[Z')
  assert.equal(byId('enter').data, '\r')
  assert.equal(byId('ctrl-c').data, '\x03')
  assert.equal(byId('ctrl-d').data, '\x04')
  assert.equal(byId('ctrl-z').data, '\x1a')
  assert.equal(byId('ctrl-r').data, '\x12')
  assert.equal(byId('ctrl-l').data, '\x0c')
  assert.equal(byId('ctrl-u').data, '\x15')
  assert.equal(byId('backspace').data, '\x7f')
})

test('keys: cursor and paging sequences', () => {
  assert.equal(byId('up').data, '\x1b[A')
  assert.equal(byId('down').data, '\x1b[B')
  assert.equal(byId('right').data, '\x1b[C')
  assert.equal(byId('left').data, '\x1b[D')
  assert.equal(byId('home').data, '\x1b[H')
  assert.equal(byId('end').data, '\x1b[F')
  assert.equal(byId('pgup').data, '\x1b[5~')
  assert.equal(byId('pgdn').data, '\x1b[6~')
})

test('keys: only arrows and backspace repeat on hold', () => {
  const repeating = allKeys.filter(k => k.repeat).map(k => k.id).sort()
  assert.deepEqual(repeating, ['backspace', 'down', 'left', 'right', 'up'])
})

test('keys: the primary row has the modifier, paste, photo and more actions', () => {
  const kinds = PRIMARY_KEYS.map(k => k.kind)
  for (const kind of ['ctrl', 'paste', 'photo', 'more']) assert.ok(kinds.includes(kind as never), kind)
  assert.ok(SECONDARY_KEYS.some(k => k.kind === 'alt'))
})

test('applyModifiers: Ctrl maps letters to control characters', () => {
  assert.equal(applyModifiers('a', { ctrl: true, alt: false }), '\x01')
  assert.equal(applyModifiers('c', { ctrl: true, alt: false }), '\x03')
  assert.equal(applyModifiers('Z', { ctrl: true, alt: false }), '\x1a')
})

test('applyModifiers: Ctrl maps the punctuation that has a control code', () => {
  assert.equal(applyModifiers('[', { ctrl: true, alt: false }), '\x1b')
  assert.equal(applyModifiers('\\', { ctrl: true, alt: false }), '\x1c')
  assert.equal(applyModifiers('_', { ctrl: true, alt: false }), '\x1f')
  assert.equal(applyModifiers(' ', { ctrl: true, alt: false }), '\x00')
  assert.equal(applyModifiers('?', { ctrl: true, alt: false }), '\x7f')
})

test('applyModifiers: Ctrl leaves digits and multi-byte input alone', () => {
  assert.equal(applyModifiers('5', { ctrl: true, alt: false }), '5')
  assert.equal(applyModifiers('\x1b[A', { ctrl: true, alt: false }), '\x1b[A')
  assert.equal(applyModifiers('hello', { ctrl: true, alt: false }), 'hello')
})

test('applyModifiers: Alt prefixes ESC, and combines with Ctrl', () => {
  assert.equal(applyModifiers('x', { ctrl: false, alt: true }), '\x1bx')
  assert.equal(applyModifiers('x', { ctrl: true, alt: true }), '\x1b\x18')
})

test('applyModifiers: no modifiers is the identity', () => {
  assert.equal(applyModifiers('q', NO_MODIFIERS), 'q')
})

test('repeatDelay: a long first wait, then a fast interval', () => {
  assert.equal(repeatDelay(0), REPEAT_INITIAL_MS)
  assert.equal(repeatDelay(1), REPEAT_INTERVAL_MS)
  assert.equal(repeatDelay(9), REPEAT_INTERVAL_MS)
  assert.ok(REPEAT_INITIAL_MS > REPEAT_INTERVAL_MS * 3)
})

// ---------------------------------------------------------------------------
// M4: PWA manifest, icons, service worker policy
// ---------------------------------------------------------------------------

const PUBLIC_DIR = path.resolve(process.cwd(), 'public')

/** Width/height from a PNG's IHDR chunk (bytes 16–23 of the file). */
async function pngSize(file: string): Promise<{ width: number; height: number }> {
  const buf = await fs.readFile(file)
  assert.deepEqual(Array.from(buf.subarray(0, 8)), [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], `${file} is not a PNG`)
  assert.equal(buf.subarray(12, 16).toString('ascii'), 'IHDR')
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
}

test('manifest: parses and declares the fields installers look for', async () => {
  const manifest = JSON.parse(await fs.readFile(path.join(PUBLIC_DIR, 'manifest.json'), 'utf8'))
  assert.equal(manifest.display, 'standalone')
  assert.equal(manifest.start_url, '/')
  assert.ok(Array.isArray(manifest.icons) && manifest.icons.length >= 2)
  assert.ok(manifest.icons.some((i: { sizes: string }) => i.sizes === '192x192'))
  assert.ok(manifest.icons.some((i: { sizes: string }) => i.sizes === '512x512'))
  assert.ok(manifest.icons.some((i: { purpose?: string }) => i.purpose === 'maskable'))
})

test('manifest: every icon exists and has the size it claims', async () => {
  const manifest = JSON.parse(await fs.readFile(path.join(PUBLIC_DIR, 'manifest.json'), 'utf8'))
  for (const icon of manifest.icons as Array<{ src: string; sizes: string }>) {
    const [w, h] = icon.sizes.split('x').map(Number)
    const size = await pngSize(path.join(PUBLIC_DIR, icon.src))
    assert.deepEqual(size, { width: w, height: h }, icon.src)
  }
})

test('apple-touch-icon exists at the size iOS wants', async () => {
  assert.deepEqual(await pngSize(path.join(PUBLIC_DIR, 'icons/apple-touch-icon.png')), { width: 180, height: 180 })
})

/** Run public/sw.js in a stub worker scope and return what it exposed for tests. */
async function loadServiceWorker(): Promise<{
  shouldCache: (url: URL, method: string, origin: string) => boolean
  CACHE: string
  SHELL: string[]
  listeners: Record<string, unknown[]>
}> {
  const source = await fs.readFile(path.join(PUBLIC_DIR, 'sw.js'), 'utf8')
  const listeners: Record<string, unknown[]> = {}
  const self: Record<string, unknown> = {
    location: { origin: 'https://nest.example' },
    addEventListener: (name: string, fn: unknown) => {
      ;(listeners[name] ??= []).push(fn)
    },
  }
  const context = vm.createContext({ self, URL, Response, caches: {}, fetch: () => Promise.reject(new Error('offline')) })
  vm.runInContext(source, context, { filename: 'sw.js' })
  const exposed = self.__nest as { shouldCache: never; CACHE: string; SHELL: string[] }
  return { ...exposed, listeners }
}

test('service worker: registers install, activate and fetch handlers', async () => {
  const sw = await loadServiceWorker()
  assert.deepEqual(Object.keys(sw.listeners).sort(), ['activate', 'fetch', 'install'])
  assert.ok(sw.SHELL.includes('/'), 'the shell must include the app entry')
})

test('service worker: caches same-origin GETs for the shell and assets', async () => {
  const { shouldCache } = await loadServiceWorker()
  const origin = 'https://nest.example'
  assert.equal(shouldCache(new URL('/', origin), 'GET', origin), true)
  assert.equal(shouldCache(new URL('/assets/index-abc123.js', origin), 'GET', origin), true)
  assert.equal(shouldCache(new URL('/icons/icon-192.png', origin), 'GET', origin), true)
  assert.equal(shouldCache(new URL('/manifest.json', origin), 'GET', origin), true)
})

test('service worker: never touches the WebSocket, the API, or health', async () => {
  const { shouldCache } = await loadServiceWorker()
  const origin = 'https://nest.example'
  assert.equal(shouldCache(new URL('/ws', origin), 'GET', origin), false)
  assert.equal(shouldCache(new URL('/api/upload', origin), 'GET', origin), false)
  assert.equal(shouldCache(new URL('/api/upload', origin), 'POST', origin), false)
  assert.equal(shouldCache(new URL('/health', origin), 'GET', origin), false)
})

test('service worker: ignores other origins and non-GET methods', async () => {
  const { shouldCache } = await loadServiceWorker()
  const origin = 'https://nest.example'
  assert.equal(shouldCache(new URL('https://fonts.example/a.css'), 'GET', origin), false)
  assert.equal(shouldCache(new URL('/', origin), 'POST', origin), false)
})
