// The login screen, and the check that decides whether to show it.
//
// Foray's server refuses every socket and upload without a session cookie
// (src/server/auth.ts). The cookie is HttpOnly, so this page cannot see
// it; it asks GET /api/session instead, and mounts the app only once the
// server says yes. A wrong answer here costs a reload, nothing more: the
// server checks again on every request regardless.
//
// The check runs again whenever the page comes back to the foreground, so
// a cookie that expired while the phone was in a pocket lands on the
// login screen rather than on an app whose socket dials forever.

import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react'

type Gate = 'checking' | 'open' | 'login'

interface SessionResponse {
  authenticated: boolean
}

interface LoginError {
  error?: string
  retryAfterS?: number
}

/** Ask the server whether this browser is logged in; null when it cannot be reached. */
async function checkSession(fetchImpl: typeof fetch = fetch): Promise<boolean | null> {
  try {
    const res = await fetchImpl('/api/session', { credentials: 'same-origin', cache: 'no-store' })
    if (res.status === 401) return false
    if (!res.ok) return null
    const body = (await res.json()) as SessionResponse
    return body.authenticated === true
  } catch {
    return null
  }
}

/** Present the token; resolves with the message to show on failure, or null on success. */
export async function login(token: string, fetchImpl: typeof fetch = fetch): Promise<string | null> {
  let res: Response
  try {
    res = await fetchImpl('/api/login', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    })
  } catch {
    return 'Could not reach the server'
  }
  if (res.ok) return null
  const body = (await res.json().catch(() => null)) as LoginError | null
  if (res.status === 429) {
    const wait = body?.retryAfterS
    return wait ? `Too many attempts. Try again in ${wait}s.` : 'Too many attempts. Try again in a minute.'
  }
  if (res.status === 401) return 'That is not the token.'
  return body?.error ?? `The server answered ${res.status}.`
}

export function AuthGate({ children }: { children: ReactNode }) {
  const [gate, setGate] = useState<Gate>('checking')

  const check = useCallback(async () => {
    const ok = await checkSession()
    // Unreachable: let the app in, where the socket's own status shows
    // the outage and this check runs again when the page wakes.
    setGate(ok === false ? 'login' : 'open')
  }, [])

  useEffect(() => {
    void check()
    const wake = () => {
      if (document.visibilityState === 'visible') void check()
    }
    document.addEventListener('visibilitychange', wake)
    window.addEventListener('pageshow', wake)
    window.addEventListener('online', wake)
    return () => {
      document.removeEventListener('visibilitychange', wake)
      window.removeEventListener('pageshow', wake)
      window.removeEventListener('online', wake)
    }
  }, [check])

  if (gate === 'checking') return null
  if (gate === 'login') return <Login onLoggedIn={() => setGate('open')} />
  return <>{children}</>
}

function Login({ onLoggedIn }: { onLoggedIn: () => void }) {
  const [token, setToken] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    const value = token.trim()
    if (!value || busy) return
    setBusy(true)
    setError(null)
    const failure = await login(value)
    setBusy(false)
    if (failure) {
      setError(failure)
      return
    }
    setToken('')
    onLoggedIn()
  }

  return (
    <main data-testid="login" className="login">
      <form className="login-card" onSubmit={submit}>
        <h1 className="login-title">foray</h1>
        <p className="login-hint">
          Paste the access token from the server. Find it with <code>npm run token</code> in the Foray checkout.
        </p>
        {/* A username the password manager can file the token under. */}
        <input type="text" name="username" value="foray" autoComplete="username" readOnly hidden />
        <input
          data-testid="login-token"
          className="field login-field"
          type="password"
          name="password"
          autoComplete="current-password"
          placeholder="access token"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          autoFocus
          aria-label="Access token"
        />
        {error && (
          <p data-testid="login-error" className="login-error" role="alert">
            {error}
          </p>
        )}
        <button data-testid="login-submit" className="btn-primary login-submit" type="submit" disabled={busy || !token.trim()}>
          {busy ? 'Checking…' : 'Log in'}
        </button>
      </form>
    </main>
  )
}
