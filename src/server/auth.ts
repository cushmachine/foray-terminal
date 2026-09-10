// Authentication for Foray.
//
// Foray is a root-equivalent shell on the machine it runs on, so every
// route that does anything (the WebSocket, uploads) requires proof that
// the caller holds the access token. The token is one secret per install:
// FORAY_TOKEN in the environment, or else ~/.foray/token, generated on
// first start (mode 0600) and printed by `npm run token`.
//
// A browser presents the token once (POST /api/login) and gets a cookie.
// The cookie is derived from the token, not stored anywhere, so a deploy
// (a restart) does not log every phone out, and rotating the token logs
// every device out at once. It carries its issue time and an HMAC over
// that time keyed by the token; verification checks the HMAC in constant
// time and the age against the session lifetime.
//
// The cookie is HttpOnly and SameSite=Strict, so a page on another origin
// cannot read it or make the browser send it. On top of that, any request
// that carries an Origin header must name this host: a cross-site
// WebSocket or form POST is refused even if a cookie somehow rode along.
//
// Non-browser clients (the test suites, scripts) send the token itself as
// `Authorization: Bearer <token>` instead of logging in.

import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type http from 'node:http'

export const TOKEN_ENV = 'FORAY_TOKEN'
export const DEFAULT_TOKEN_FILE = path.join(os.homedir(), '.foray', 'token')
export const SESSION_COOKIE = 'foray_session'
/** How long a login lasts before the browser must present the token again. */
export const DEFAULT_SESSION_MAX_AGE_S = 30 * 24 * 60 * 60

/** Failed logins from one address before it has to wait. */
export const LOGIN_FAILURES_BEFORE_DELAY = 5
/** First wait after too many failures; doubles per further failure. */
export const LOGIN_DELAY_BASE_MS = 30_000
/**
 * Longest wait. Behind `tailscale serve` every client is 127.0.0.1, so one
 * address's lockout is everyone's; a cap keeps a flood from locking the
 * owner out for long (existing cookies keep working regardless).
 */
export const LOGIN_DELAY_MAX_MS = 15 * 60 * 1000

/** Shortest token accepted from the environment or the token file. */
const MIN_TOKEN_CHARS = 16

export interface AuthOptions {
  /** The token itself; tests pass one. Wins over the env and the file. */
  token?: string
  /** Where to read (or create) the token when neither `token` nor FORAY_TOKEN is set. */
  tokenFile?: string
  /** Environment to read FORAY_TOKEN from. */
  env?: NodeJS.ProcessEnv
  sessionMaxAgeS?: number
  /** Clock, for tests. */
  now?: () => number
}

/** Where the token in use came from, for the startup log. */
export type TokenSource = 'option' | 'env' | 'file'

export interface LoadedToken {
  token: string
  source: TokenSource
  /** Set when the token was read from, or written to, a file. */
  file?: string
  /** True when this start generated the token. */
  created: boolean
}

/** A fresh token: 32 random bytes, URL-safe, no padding. */
export function generateToken(): string {
  return crypto.randomBytes(32).toString('base64url')
}

/**
 * The token to authenticate against, from the first of: `options.token`,
 * FORAY_TOKEN, the token file (created with a fresh token if missing).
 * A token shorter than MIN_TOKEN_CHARS is refused: a guessable token is
 * worse than none, because it looks like protection.
 */
export function loadToken(options: AuthOptions = {}): LoadedToken {
  const env = options.env ?? process.env
  if (options.token !== undefined) {
    return { token: checkToken(options.token, 'the auth option'), source: 'option', created: false }
  }
  const fromEnv = env[TOKEN_ENV]
  if (fromEnv !== undefined && fromEnv !== '') {
    return { token: checkToken(fromEnv, TOKEN_ENV), source: 'env', created: false }
  }
  const file = options.tokenFile ?? DEFAULT_TOKEN_FILE
  let existing: string | null = null
  try {
    existing = fs.readFileSync(file, 'utf8').trim()
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }
  if (existing !== null && existing !== '') {
    return { token: checkToken(existing, file), source: 'file', file, created: false }
  }
  const token = generateToken()
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  fs.writeFileSync(file, `${token}\n`, { mode: 0o600, flag: 'w' })
  fs.chmodSync(file, 0o600)
  return { token, source: 'file', file, created: true }
}

function checkToken(token: string, where: string): string {
  const trimmed = token.trim()
  if (trimmed.length < MIN_TOKEN_CHARS) {
    throw new Error(`The Foray token from ${where} is too short: use at least ${MIN_TOKEN_CHARS} characters (npm run token makes one)`)
  }
  return trimmed
}

/** Constant-time equality of two strings of any length. */
export function safeEqual(a: string, b: string): boolean {
  const ha = crypto.createHash('sha256').update(a).digest()
  const hb = crypto.createHash('sha256').update(b).digest()
  return crypto.timingSafeEqual(ha, hb)
}

/** The `Cookie` header as a map; malformed pairs are skipped. */
export function parseCookies(header: string | undefined): Map<string, string> {
  const cookies = new Map<string, string>()
  if (!header) return cookies
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq < 0) continue
    const name = part.slice(0, eq).trim()
    const value = part.slice(eq + 1).trim()
    if (name) cookies.set(name, value)
  }
  return cookies
}

/**
 * Whether a request's Origin, when it has one, is this server. Browsers
 * send Origin on every WebSocket upgrade and cross-site POST, so a
 * mismatch is a page elsewhere trying to use the user's network position.
 * A request with no Origin is not from a browser page (or is a same-origin
 * GET), and still has to authenticate.
 */
export function originAllowed(req: http.IncomingMessage): boolean {
  const origin = req.headers.origin
  if (origin === undefined) return true
  if (Array.isArray(origin)) return false
  let originHost: string
  try {
    originHost = new URL(origin).host
  } catch {
    return false
  }
  if (!originHost) return false
  return requestHosts(req).includes(canonicalHost(originHost))
}

/**
 * A host for comparison: lower-case, without a default port. A browser
 * writes Origin without :80 or :443; a proxy may write Host with it.
 */
export function canonicalHost(host: string): string {
  return host.toLowerCase().replace(/:(80|443)$/, '')
}

/**
 * The address a request came from, for the login limiter. Behind a proxy
 * on this machine (`tailscale serve`) every socket is loopback, so the
 * proxy's X-Forwarded-For is what tells clients apart; from anywhere
 * else that header is whatever the client wrote and is ignored.
 */
export function clientAddress(req: http.IncomingMessage): string {
  const direct = req.socket.remoteAddress ?? 'unknown'
  if (!isLoopbackAddress(direct)) return direct
  const forwarded = req.headers['x-forwarded-for']
  if (typeof forwarded !== 'string') return direct
  const first = forwarded.split(',')[0].trim()
  return first || direct
}

function isLoopbackAddress(address: string): boolean {
  return address === '::1' || address === '127.0.0.1' || address === '::ffff:127.0.0.1' || address.startsWith('127.')
}

/**
 * The names this request addressed the server by: its Host header and,
 * behind a proxy that rewrites Host to the backend address, the original
 * in X-Forwarded-Host. A direct client can forge X-Forwarded-Host, but it
 * can forge Origin just as well; the check exists for browsers, which can
 * set neither.
 */
export function requestHosts(req: http.IncomingMessage): string[] {
  const hosts: string[] = []
  for (const header of [req.headers.host, req.headers['x-forwarded-host']]) {
    if (typeof header !== 'string') continue
    for (const part of header.split(',')) {
      const name = canonicalHost(part.trim())
      if (name) hosts.push(name)
    }
  }
  return hosts
}

/** Whether the request arrived over TLS, directly or via a proxy that says so. */
export function isSecureRequest(req: http.IncomingMessage): boolean {
  if ((req.socket as { encrypted?: boolean }).encrypted) return true
  const proto = req.headers['x-forwarded-proto']
  return typeof proto === 'string' && proto.split(',')[0].trim().toLowerCase() === 'https'
}

/** Failed-login bookkeeping for one client address. */
interface Strikes {
  failures: number
  /** Epoch ms before which further attempts are refused. */
  blockedUntil: number
}

export class Auth {
  private readonly token: string
  private readonly sessionKey: Buffer
  private readonly sessionMaxAgeS: number
  private readonly now: () => number
  private readonly strikes = new Map<string, Strikes>()

  constructor(token: string, options: Pick<AuthOptions, 'sessionMaxAgeS' | 'now'> = {}) {
    this.token = token
    // The cookie is signed with a key derived from the token, never the
    // token itself, so a cookie can not be turned back into the token.
    this.sessionKey = crypto.createHash('sha256').update(`foray-session-v1:${token}`).digest()
    this.sessionMaxAgeS = options.sessionMaxAgeS ?? DEFAULT_SESSION_MAX_AGE_S
    this.now = options.now ?? (() => Date.now())
  }

  /** Whether `candidate` is the token. Constant time. */
  verifyToken(candidate: unknown): boolean {
    return typeof candidate === 'string' && safeEqual(candidate, this.token)
  }

  /** A new session cookie value, dated now. */
  issueSession(): string {
    const issuedAt = Math.floor(this.now() / 1000).toString(36)
    return `${issuedAt}.${this.sign(issuedAt)}`
  }

  /** Whether a cookie value is one this server issued, within its lifetime. */
  verifySession(value: string | undefined): boolean {
    if (!value) return false
    const dot = value.indexOf('.')
    if (dot <= 0) return false
    const issuedAt = value.slice(0, dot)
    const mac = value.slice(dot + 1)
    if (!/^[0-9a-z]+$/.test(issuedAt)) return false
    if (!safeEqual(mac, this.sign(issuedAt))) return false
    const ageS = this.now() / 1000 - parseInt(issuedAt, 36)
    return ageS >= -60 && ageS <= this.sessionMaxAgeS
  }

  private sign(issuedAt: string): string {
    return crypto.createHmac('sha256', this.sessionKey).update(issuedAt).digest('base64url')
  }

  /** The Set-Cookie header for a session cookie (or, with '', to clear it). */
  cookieHeader(value: string, secure: boolean): string {
    const attrs = [
      `${SESSION_COOKIE}=${value}`,
      'Path=/',
      'HttpOnly',
      'SameSite=Strict',
      `Max-Age=${value ? this.sessionMaxAgeS : 0}`,
    ]
    if (secure) attrs.push('Secure')
    return attrs.join('; ')
  }

  /**
   * Whether a request proves it may act: a valid session cookie, or the
   * token as a bearer credential.
   */
  isAuthenticated(req: http.IncomingMessage): boolean {
    const cookie = parseCookies(req.headers.cookie).get(SESSION_COOKIE)
    if (this.verifySession(cookie)) return true
    const authorization = req.headers.authorization
    if (typeof authorization === 'string' && authorization.startsWith('Bearer ')) {
      return this.verifyToken(authorization.slice('Bearer '.length).trim())
    }
    return false
  }

  /**
   * Milliseconds an address must still wait before another login attempt,
   * or 0 when it may try now.
   */
  loginDelayMs(address: string): number {
    const strikes = this.strikes.get(address)
    if (!strikes) return 0
    return Math.max(0, strikes.blockedUntil - this.now())
  }

  /** Record a failed login; the wait grows with each failure past the allowance. */
  recordLoginFailure(address: string): void {
    this.prune()
    const strikes = this.strikes.get(address) ?? { failures: 0, blockedUntil: 0 }
    strikes.failures += 1
    const over = strikes.failures - LOGIN_FAILURES_BEFORE_DELAY
    if (over >= 0) {
      const delay = Math.min(LOGIN_DELAY_MAX_MS, LOGIN_DELAY_BASE_MS * 2 ** over)
      strikes.blockedUntil = this.now() + delay
    }
    this.strikes.set(address, strikes)
  }

  /** A successful login clears the address's record. */
  recordLoginSuccess(address: string): void {
    this.strikes.delete(address)
  }

  /** Forget addresses whose wait has long expired, so the map cannot grow forever. */
  private prune(): void {
    if (this.strikes.size < 1000) return
    const now = this.now()
    for (const [address, strikes] of this.strikes) {
      if (strikes.blockedUntil < now - LOGIN_DELAY_MAX_MS) this.strikes.delete(address)
    }
  }
}
