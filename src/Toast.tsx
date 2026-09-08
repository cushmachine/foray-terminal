import { useEffect } from 'react'

interface ToastProps {
  message: string | null
  onDismiss: () => void
}

/** How long a toast stays before dismissing itself. */
export const TOAST_MS = 6000

/**
 * A short-lived strip at the bottom of the page for failures nothing else
 * shows (a session op the server rejected). Same look as VersionBanner.
 */
export function Toast({ message, onDismiss }: ToastProps) {
  useEffect(() => {
    if (message === null) return
    const timer = setTimeout(onDismiss, TOAST_MS)
    return () => clearTimeout(timer)
  }, [message, onDismiss])

  if (message === null) return null
  return (
    <div
      data-testid="toast"
      role="alert"
      style={{
        position: 'fixed',
        bottom: 'calc(12px + env(safe-area-inset-bottom))',
        left: '50%',
        transform: 'translateX(-50%)',
        maxWidth: 'calc(100vw - 24px)',
        zIndex: 'var(--z-banner)',
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '6px 12px',
        background: 'var(--surface)',
        border: '1px solid var(--danger)',
        borderRadius: 'var(--radius-md)',
        color: 'var(--text)',
        fontSize: 12,
        boxShadow: '0 4px 24px rgba(0,0,0,0.5)',
      }}
    >
      <span style={{ overflowWrap: 'anywhere' }}>{message}</span>
      <button className="btn-outline tone-accent" onClick={onDismiss} aria-label="Dismiss" title="Dismiss">×</button>
    </div>
  )
}
