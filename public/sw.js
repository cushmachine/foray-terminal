// Foray service worker.
//
// Foray is useless without its server, so this is not an "offline app". It
// exists so a Home Screen launch paints the shell instantly from cache and
// a flaky connection shows a real "can't reach Foray" screen instead of the
// browser's white error page. Strategy: network first, cache as fallback,
// for same-origin GETs only. The WebSocket and the upload API are never
// touched.
//
// Registered by src/main.tsx in production builds only. Bump CACHE when
// the shell list or the offline page changes.

const CACHE = 'foray-shell-v1'
const SHELL = ['/', '/manifest.json']

/** Paths the worker must stay out of: live protocol, uploads, health. */
const BYPASS_PREFIXES = ['/ws', '/api/', '/health']

/**
 * Whether a request is the worker's business. Pure so it can be tested
 * outside a worker (see src/__tests__/mobile.test.ts).
 * @param {URL} url
 * @param {string} method
 * @param {string} origin the worker's own origin
 */
function shouldCache(url, method, origin) {
  if (method !== 'GET') return false
  if (url.origin !== origin) return false
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
  return !BYPASS_PREFIXES.some((prefix) => url.pathname === prefix || url.pathname.startsWith(prefix))
}

/**
 * Drop cached /assets/* entries the freshly fetched page no longer loads:
 * every build renames the hashed bundle files, so whatever an older page
 * referenced is dead weight. Done after every successful navigation rather
 * than on activate, since this file seldom changes between builds.
 */
async function evictStaleAssets(cache, html) {
  const live = new Set(Array.from(html.matchAll(/\b(?:src|href)="(\/assets\/[^"]+)"/g), (m) => m[1]))
  for (const req of await cache.keys()) {
    const pathname = new URL(req.url).pathname
    if (pathname.startsWith('/assets/') && !live.has(pathname)) await cache.delete(req)
  }
}

function offlinePage() {
  const html = `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Foray</title>
<style>
  html { background: #0a0a0c; color: #d4d4d8; font: 15px -apple-system, system-ui, sans-serif; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; text-align: center; }
  h1 { color: #3db8a9; font: 700 20px/1.2 ui-monospace, monospace; letter-spacing: .04em; margin: 0 0 8px; }
  p { color: #636370; margin: 0 0 20px; }
  button { background: #1a2e2b; color: #3db8a9; border: 1px solid #3db8a9; border-radius: 8px;
    padding: 12px 22px; font: 600 14px ui-monospace, monospace; min-height: 44px; }
</style>
<div>
  <h1>foray</h1>
  <p>can't reach the server</p>
  <button onclick="location.reload()">retry</button>
</div>`
  return new Response(html, {
    status: 503,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  })
}

async function networkFirst(event) {
  const request = event.request
  const cache = await caches.open(CACHE)
  try {
    const response = await fetch(request)
    if (response.ok) {
      cache.put(request, response.clone())
      if (request.mode === 'navigate') {
        // waitUntil keeps the worker alive for the prune; the page is not
        // held up because the response is returned right away.
        event.waitUntil(response.clone().text().then((html) => evictStaleAssets(cache, html)))
      }
    }
    return response
  } catch (err) {
    const cached = await cache.match(request, { ignoreSearch: request.mode === 'navigate' })
    if (cached) return cached
    if (request.mode === 'navigate') {
      const shell = await cache.match('/')
      return shell ?? offlinePage()
    }
    throw err
  }
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting()),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  )
})

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url)
  if (!shouldCache(url, event.request.method, self.location.origin)) return
  event.respondWith(networkFirst(event))
})

// Exposed for tests, which run this file in a stub worker scope.
self.__foray = { shouldCache, CACHE, SHELL }
