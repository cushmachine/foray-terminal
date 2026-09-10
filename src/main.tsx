import React from 'react'
import ReactDOM from 'react-dom/client'
import { App } from './App'
import { AuthGate } from './AuthGate'
import { ErrorBoundary } from './ErrorBoundary'
import './styles.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <AuthGate>
        <App />
      </AuthGate>
    </ErrorBoundary>
  </React.StrictMode>
)

// Cache the shell for instant Home Screen launches (see public/sw.js).
// Dev builds skip it: a worker serving stale modules is a debugging trap.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {
      // Foray works without it; nothing to tell the user.
    })
  })
}
