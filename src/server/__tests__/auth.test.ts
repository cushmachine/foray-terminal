// Authentication and the request guards around it (server/auth.ts and the
// routes and upgrade check in server/index.ts).
//
// Foray is a shell on the machine it runs on, so these are the tests that
// say who gets one: a browser with the cookie a login earned, or a client
// holding the token itself; and never a page on another origin, whatever
// it carries.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import http from 'node:http'
import path from 'node:path'
import {
  Auth, clientAddress, loadToken, originAllowed, parseCookies, safeEqual, SESSION_COOKIE,
  LOGIN_FAILURES_BEFORE_DELAY, LOGIN_DELAY_BASE_MS, LOGIN_DELAY_MAX_MS,
} from '../auth.ts'
import { isLoopback, MAX_WS_PAYLOAD_BYTES } from '../index.ts'
import { ptyEnv } from '../pty-bridge.ts'
import { connect, startTestServer, tmpDir, wsUrl, waitForType, TEST_TOKEN, type Msg } from './helpers.ts'

const HOUR = 60 * 60 * 1000

// ---------------------------------------------------------------------------
// The token
// ---------------------------------------------------------------------------

test('loadToken: creates the token file, owner-only, when there is none', async () => {
  const dir = await tmpDir('foray-auth-')
  try {
    const file = path.join(dir, 'nested', 'token')
    const first = loadToken({ tokenFile: file, env: {} })
    assert.equal(first.source, 'file')
    assert.equal(first.created, true)
    assert.ok(first.token.length >= 32)
    const stat = await fs.stat(file)
    assert.equal(stat.mode & 0o777, 0o600)
    assert.equal((await fs.stat(path.dirname(file))).mode & 0o777, 0o700)
    assert.equal((await fs.readFile(file, 'utf8')).trim(), first.token)

    const second = loadToken({ tokenFile: file, env: {} })
    assert.equal(second.created, false)
    assert.equal(second.token, first.token, 'the next start reads the same token back')
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('loadToken: the option wins over the environment, which wins over the file', async () => {
  const dir = await tmpDir('foray-auth-')
  try {
    const file = path.join(dir, 'token')
    await fs.writeFile(file, 'file-token-0123456789abcdef\n')
    const env = { FORAY_TOKEN: 'env-token-0123456789abcdef' }
    assert.equal(loadToken({ tokenFile: file, env }).token, 'env-token-0123456789abcdef')
    assert.equal(loadToken({ tokenFile: file, env }).source, 'env')
    assert.equal(loadToken({ tokenFile: file, env: {} }).token, 'file-token-0123456789abcdef')
    assert.equal(loadToken({ token: TEST_TOKEN, tokenFile: file, env }).token, TEST_TOKEN)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('loadToken: a short token is refused wherever it comes from', () => {
  assert.throws(() => loadToken({ token: 'hunter2', env: {} }), /too short/)
  assert.throws(() => loadToken({ env: { FORAY_TOKEN: 'short' } }), /too short/)
})

test('safeEqual compares strings of any length without throwing', () => {
  assert.equal(safeEqual('abc', 'abc'), true)
  assert.equal(safeEqual('abc', 'abcd'), false)
  assert.equal(safeEqual('', 'abc'), false)
})

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

test('a session cookie verifies until it expires, and not when tampered with', () => {
  let now = 1_700_000_000_000
  const auth = new Auth(TEST_TOKEN, { sessionMaxAgeS: 3600, now: () => now })
  const cookie = auth.issueSession()
  assert.equal(auth.verifySession(cookie), true)
  assert.equal(auth.verifySession(undefined), false)
  assert.equal(auth.verifySession(''), false)
  assert.equal(auth.verifySession(`${cookie}x`), false, 'a changed signature')
  const [issuedAt, mac] = cookie.split('.')
  assert.equal(auth.verifySession(`${issuedAt}0.${mac}`), false, 'a changed timestamp')
  assert.equal(auth.verifySession(`${issuedAt}.${mac}`), true)

  now += 3599 * 1000
  assert.equal(auth.verifySession(cookie), true, 'inside the lifetime')
  now += 2 * 1000
  assert.equal(auth.verifySession(cookie), false, 'past the lifetime')

  const other = new Auth('another-token-0123456789abcdef', { now: () => now })
  assert.equal(other.verifySession(other.issueSession()), true)
  assert.equal(other.verifySession(auth.issueSession()), false, 'a rotated token invalidates every cookie')
})

test('the cookie is HttpOnly and SameSite=Strict, and Secure only over TLS', () => {
  const auth = new Auth(TEST_TOKEN)
  const plain = auth.cookieHeader('v', false)
  assert.match(plain, new RegExp(`^${SESSION_COOKIE}=v; Path=/; HttpOnly; SameSite=Strict; Max-Age=\\d+$`))
  assert.match(auth.cookieHeader('v', true), /; Secure$/)
  assert.match(auth.cookieHeader('', false), /Max-Age=0/, 'clearing sets an expired cookie')
})

test('parseCookies reads the header the way browsers write it', () => {
  const cookies = parseCookies(`a=1; ${SESSION_COOKIE}=x.y; weird; b=with=equals`)
  assert.equal(cookies.get('a'), '1')
  assert.equal(cookies.get(SESSION_COOKIE), 'x.y')
  assert.equal(cookies.get('b'), 'with=equals')
  assert.equal(parseCookies(undefined).size, 0)
})

test('login failures earn a growing wait, capped, and a success clears it', () => {
  let now = 0
  const auth = new Auth(TEST_TOKEN, { now: () => now })
  for (let i = 0; i < LOGIN_FAILURES_BEFORE_DELAY - 1; i++) auth.recordLoginFailure('1.2.3.4')
  assert.equal(auth.loginDelayMs('1.2.3.4'), 0, 'a few slips cost nothing')
  auth.recordLoginFailure('1.2.3.4')
  assert.equal(auth.loginDelayMs('1.2.3.4'), LOGIN_DELAY_BASE_MS)
  assert.equal(auth.loginDelayMs('5.6.7.8'), 0, 'another address is unaffected')
  auth.recordLoginFailure('1.2.3.4')
  assert.equal(auth.loginDelayMs('1.2.3.4'), LOGIN_DELAY_BASE_MS * 2)
  for (let i = 0; i < 20; i++) auth.recordLoginFailure('1.2.3.4')
  assert.equal(auth.loginDelayMs('1.2.3.4'), LOGIN_DELAY_MAX_MS, 'the wait is capped')
  now += HOUR
  assert.equal(auth.loginDelayMs('1.2.3.4'), 0, 'the wait passes')
  auth.recordLoginSuccess('1.2.3.4')
  auth.recordLoginFailure('1.2.3.4')
  assert.equal(auth.loginDelayMs('1.2.3.4'), 0, 'a success reset the count')
})

// ---------------------------------------------------------------------------
// Origin
// ---------------------------------------------------------------------------

function fakeRequest(headers: Record<string, string | undefined>): import('node:http').IncomingMessage {
  return { headers, socket: {} } as unknown as import('node:http').IncomingMessage
}

test('originAllowed: same host passes, another origin or a malformed one does not, no Origin passes', () => {
  assert.equal(originAllowed(fakeRequest({ host: 'box:3000', origin: 'http://box:3000' })), true)
  assert.equal(originAllowed(fakeRequest({ host: 'box:3000', origin: 'https://BOX:3000' })), true, 'scheme and case do not matter')
  assert.equal(originAllowed(fakeRequest({ host: 'box:3000', origin: 'http://evil.example' })), false)
  assert.equal(originAllowed(fakeRequest({ host: 'box:3000', origin: 'http://box' })), false, 'the port is part of the host')
  assert.equal(originAllowed(fakeRequest({ host: 'box:3000', origin: 'null' })), false)
  assert.equal(originAllowed(fakeRequest({ host: 'box:3000', origin: '' })), false)
  assert.equal(originAllowed(fakeRequest({ host: 'box:3000' })), true, 'not a browser page; still has to authenticate')
  assert.equal(
    originAllowed(fakeRequest({ host: '127.0.0.1:3000', 'x-forwarded-host': 'box.tail1.ts.net', origin: 'https://box.tail1.ts.net' })),
    true,
    'behind a proxy that rewrote Host, the forwarded host counts',
  )
  assert.equal(originAllowed(fakeRequest({ host: '[::1]:3000', origin: 'http://[::1]:3000' })), true, 'IPv6 literal')
  assert.equal(originAllowed(fakeRequest({ host: 'box.tail1.ts.net:443', origin: 'https://box.tail1.ts.net' })), true, 'a default port a proxy wrote out')
  assert.equal(originAllowed(fakeRequest({ host: 'box:80', origin: 'http://box' })), true)
})

test('clientAddress: the socket address, or the first forwarded hop behind a loopback proxy', () => {
  const at = (remoteAddress: string, forwarded?: string) =>
    clientAddress({ headers: { 'x-forwarded-for': forwarded }, socket: { remoteAddress } } as unknown as import('node:http').IncomingMessage)
  assert.equal(at('100.64.1.2', '9.9.9.9'), '100.64.1.2', 'a direct client cannot pick its own address')
  assert.equal(at('127.0.0.1', '100.64.1.2, 10.0.0.1'), '100.64.1.2')
  assert.equal(at('::ffff:127.0.0.1', '100.64.1.2'), '100.64.1.2')
  assert.equal(at('127.0.0.1'), '127.0.0.1', 'loopback with no proxy header stays loopback')
})

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

test('every response carries the security headers', async () => {
  const { url, close } = await startTestServer()
  try {
    const res = await fetch(`${url}/health`)
    assert.equal(res.status, 200)
    assert.match(res.headers.get('content-security-policy') ?? '', /frame-ancestors 'none'/)
    assert.match(res.headers.get('content-security-policy') ?? '', /connect-src 'self' ws:\/\/localhost:\d+ wss:\/\/localhost:\d+/)
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff')
    assert.equal(res.headers.get('x-frame-options'), 'DENY')
    assert.equal(res.headers.get('referrer-policy'), 'no-referrer')
    assert.equal(res.headers.get('x-powered-by'), null)
    assert.equal(res.headers.get('strict-transport-security'), null, 'no HSTS over plain http')
    const api = await fetch(`${url}/api/session`)
    assert.equal(api.headers.get('cache-control'), 'no-store')
  } finally {
    await close()
  }
})

test('login: the token earns a cookie; the cookie opens /api/session; a wrong token does not', async () => {
  const { url, close } = await startTestServer()
  try {
    assert.equal((await fetch(`${url}/api/session`)).status, 401)

    const wrong = await fetch(`${url}/api/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: 'nope' }),
    })
    assert.equal(wrong.status, 401)
    assert.equal(wrong.headers.get('set-cookie'), null)

    const right = await fetch(`${url}/api/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: TEST_TOKEN }),
    })
    assert.equal(right.status, 200)
    const setCookie = right.headers.get('set-cookie') ?? ''
    assert.match(setCookie, new RegExp(`^${SESSION_COOKIE}=[0-9a-z]+\\.[A-Za-z0-9_-]+; Path=/; HttpOnly; SameSite=Strict`))
    const cookie = setCookie.split(';')[0]

    const session = await fetch(`${url}/api/session`, { headers: { cookie } })
    assert.equal(session.status, 200)
    assert.deepEqual(await session.json(), { authenticated: true, required: true })
    assert.match(session.headers.get('set-cookie') ?? '', new RegExp(`^${SESSION_COOKIE}=`), 'the check renews the cookie')

    const bearer = await fetch(`${url}/api/session`, { headers: { authorization: `Bearer ${TEST_TOKEN}` } })
    assert.equal(bearer.status, 200)
    assert.equal(bearer.headers.get('set-cookie'), null, 'a bearer client gets no cookie')

    const logout = await fetch(`${url}/api/logout`, { method: 'POST', headers: { cookie } })
    assert.match(logout.headers.get('set-cookie') ?? '', /Max-Age=0/)
    const strangerLogout = await fetch(`${url}/api/logout`, { method: 'POST', headers: { cookie, origin: 'http://evil.example' } })
    assert.equal(strangerLogout.status, 403, 'another site cannot log the browser out')
    assert.equal((await fetch(`${url}/api/logout`, { method: 'POST' })).status, 401)
  } finally {
    await close()
  }
})

test('login: a cross-origin POST is refused before the token is even looked at', async () => {
  const { url, close } = await startTestServer()
  try {
    const res = await fetch(`${url}/api/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://evil.example' },
      body: JSON.stringify({ token: TEST_TOKEN }),
    })
    assert.equal(res.status, 403)
    assert.equal(res.headers.get('set-cookie'), null)
  } finally {
    await close()
  }
})

test('login: too many wrong tokens from one address are answered 429 with a Retry-After', async () => {
  const { url, close } = await startTestServer()
  try {
    const attempt = () => fetch(`${url}/api/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: 'guess' }),
    })
    for (let i = 0; i < LOGIN_FAILURES_BEFORE_DELAY; i++) assert.equal((await attempt()).status, 401)
    const blocked = await attempt()
    assert.equal(blocked.status, 429)
    assert.ok(Number(blocked.headers.get('retry-after')) > 0)
    const body = (await blocked.json()) as { retryAfterS: number }
    assert.ok(body.retryAfterS > 0)
    // The right token is refused too while the wait runs: guessing is over.
    const right = await fetch(`${url}/api/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: TEST_TOKEN }),
    })
    assert.equal(right.status, 429)
  } finally {
    await close()
  }
})

test('upload: refused without a credential, and from another origin even with one', async () => {
  const { url, close } = await startTestServer()
  try {
    const form = new FormData()
    form.append('file', new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])], { type: 'image/png' }), 'x.png')
    const anonymous = await fetch(`${url}/api/upload`, { method: 'POST', body: form })
    assert.equal(anonymous.status, 401)
    const crossSite = await fetch(`${url}/api/upload`, {
      method: 'POST', body: form, headers: { authorization: `Bearer ${TEST_TOKEN}`, origin: 'http://evil.example' },
    })
    assert.equal(crossSite.status, 403)
  } finally {
    await close()
  }
})

/** GET a path with a chosen Host header, which fetch() does not allow. */
function getAs(url: string, host: string, pathname: string): Promise<number> {
  const { hostname, port } = new URL(url)
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname, port, path: pathname, headers: { host } }, (res) => {
      res.resume()
      resolve(res.statusCode ?? 0)
    })
    req.on('error', reject)
    req.end()
  })
}

test('an allowed-hosts list turns away requests for any other name', async () => {
  const { url, close } = await startTestServer({ allowedHosts: ['foray.example'] })
  try {
    assert.equal(await getAs(url, 'localhost:3000', '/health'), 421, 'localhost is not on the list')
    assert.equal(await getAs(url, 'attacker.example:3000', '/health'), 421)
    assert.equal(await getAs(url, 'foray.example:3000', '/health'), 200)
    assert.equal(await getAs(url, 'FORAY.example', '/health'), 200, 'case and port do not matter')
    await assert.rejects(dial(url, { authorization: `Bearer ${TEST_TOKEN}`, host: 'attacker.example' }), /refused/)
  } finally {
    await close()
  }
})

// ---------------------------------------------------------------------------
// The WebSocket
// ---------------------------------------------------------------------------

/** Dial the socket; resolve with the welcome, or reject when the server refuses the upgrade. */
async function dial(url: string, headers: Record<string, string>): Promise<Msg> {
  const ws = new WebSocket(wsUrl(url), { headers } as unknown as string[])
  try {
    return await Promise.race([
      waitForType(ws, 'session:list', 3000),
      new Promise<Msg>((_, reject) => {
        ws.addEventListener('close', (ev) => reject(new Error(`refused: ${(ev as { code?: number }).code ?? '?'}`)), { once: true })
      }),
    ])
  } finally {
    ws.close()
  }
}

test('the socket opens for the token or the cookie, and for nothing else', async () => {
  const { url, close } = await startTestServer()
  try {
    await assert.rejects(dial(url, {}), /refused/)
    await assert.rejects(dial(url, { authorization: 'Bearer wrong' }), /refused/)
    await assert.rejects(dial(url, { cookie: `${SESSION_COOKIE}=forged.value` }), /refused/)

    const login = await fetch(`${url}/api/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: TEST_TOKEN }),
    })
    const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0]
    assert.equal((await dial(url, { cookie })).type, 'session:list')
    assert.equal((await dial(url, { authorization: `Bearer ${TEST_TOKEN}` })).type, 'session:list')
  } finally {
    await close()
  }
})

test('a page on another origin cannot open the socket, even holding a credential', async () => {
  const { url, close } = await startTestServer()
  try {
    const own = new URL(url).host
    const credential = { authorization: `Bearer ${TEST_TOKEN}` }
    await assert.rejects(dial(url, { ...credential, origin: 'http://evil.example' }), /refused/)
    await assert.rejects(dial(url, { ...credential, origin: `http://${own.replace(/:\d+$/, '')}` }), /refused/, 'the port counts')
    assert.equal((await dial(url, { ...credential, origin: `http://${own}` })).type, 'session:list')
  } finally {
    await close()
  }
})

test('with authentication off the socket opens bare; a login is a no-op', async () => {
  const { url, close } = await startTestServer({ auth: false })
  try {
    assert.equal((await dial(url, {})).type, 'session:list')
    const session = await fetch(`${url}/api/session`)
    assert.deepEqual(await session.json(), { authenticated: true, required: false })
  } finally {
    await close()
  }
})

test('a frame past the payload cap closes the socket instead of being buffered', async () => {
  const { url, close } = await startTestServer()
  try {
    const { ws } = await connect(url)
    const closed = new Promise<number>((resolve) => {
      ws.addEventListener('close', (ev) => resolve((ev as { code: number }).code), { once: true })
    })
    ws.send(JSON.stringify({ type: 'terminal:input', windowId: 0, data: 'x'.repeat(MAX_WS_PAYLOAD_BYTES + 1) }))
    assert.equal(await closed, 1009, 'message too big')
  } finally {
    await close()
  }
})

test('the socket cap turns the next client away with 503', async () => {
  const { url, close } = await startTestServer({ maxConnections: 1 })
  try {
    const { ws } = await connect(url)
    try {
      await assert.rejects(dial(url, { authorization: `Bearer ${TEST_TOKEN}` }), /refused/)
    } finally {
      ws.close()
    }
  } finally {
    await close()
  }
})

// ---------------------------------------------------------------------------
// Around the edges
// ---------------------------------------------------------------------------

test('ptyEnv keeps Foray variables out of the shells it spawns', () => {
  const env = ptyEnv({ PATH: '/bin', FORAY_TOKEN: 'secret', FORAY_AUTH: 'on', HOME: '/root' })
  assert.deepEqual(env, { PATH: '/bin', HOME: '/root' })
})

test('isLoopback knows the addresses only this machine can reach', () => {
  assert.equal(isLoopback('127.0.0.1'), true)
  assert.equal(isLoopback('127.1.2.3'), true)
  assert.equal(isLoopback('::1'), true)
  assert.equal(isLoopback('localhost'), true)
  assert.equal(isLoopback('0.0.0.0'), false)
  assert.equal(isLoopback('100.64.1.2'), false)
  assert.equal(isLoopback(undefined), false, 'unset means every interface')
})
