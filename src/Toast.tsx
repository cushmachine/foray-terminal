import { useEffect } from 'react'
import { MONO_FONT } from './theme'

interface ToastProps {
  message: string | null
  onDismiss: () => void
}

/** How long a toast stays before dismissing itself. */
export const TOAST_MS = 6000

const buttonStyle = {
  background: 'var(--surface-2, transparent)',
  color: 'var(--accent)',
  border: '1px solid var(--accent)',
  borderRadius: 6,
  padding: '4px 10px',
  minHeight: 32,
  fontFamily: MONO_FONT,
  fontSize: 12,
  cursor: 'pointer',
} as const

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
        zIndex: 200,
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '6px 12px',
        background: 'var(--surface)',
        border: '1px solid var(--danger)',
        borderRadius: 6,
        color: 'var(--text)',
        fontFamily: MONO_FONT,
        fontSize: 12,
        boxShadow: '0 4px 24px rgba(0,0,0,0.5)',
      }}
    >
      <span style={{ overflowWrap: 'anywhere' }}>{message}</span>
      <button onClick={onDismiss} aria-label="Dismiss" style={buttonStyle}>×</button>
    </div>
  )
}
