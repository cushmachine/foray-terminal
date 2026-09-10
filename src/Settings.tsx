// Settings: the home for per-device preferences that are not actions.
//
// One row so far — terminal text size, which used to sit in the sidebar
// footer where it had nothing to do with sessions. A modal rather than a
// route because Foray has no router, and the terminal underneath should not
// be torn down to change a preference.

import type { CSSProperties } from 'react'
import { useEscape } from './hooks/useEscape'
import { MAX_FONT_SIZE, MIN_FONT_SIZE } from './mobile'

interface SettingsProps {
  open: boolean
  onClose: () => void
  isMobile: boolean
  fontSize: number
  onFontSizeChange: (size: number) => void
}

export function Settings({ open, onClose, isMobile, fontSize, onFontSizeChange }: SettingsProps) {
  useEscape(onClose, open)
  if (!open) return null

  const hit = isMobile ? 'var(--hit)' : 30
  const stepper: CSSProperties = {
    padding: 0,
    minWidth: hit,
    minHeight: hit,
    fontSize: 15,
  }

  return (
    <>
      <button
        data-testid="settings-backdrop"
        aria-label="Close settings"
        onClick={onClose}
        style={{
          position: 'fixed',
          inset: 0,
          background: 'rgba(0,0,0,0.75)',
          zIndex: 'var(--z-modal)',
          width: '100%',
          height: '100%',
          border: 'none',
          padding: 0,
          cursor: 'default',
        }}
      />

      <div
        data-testid="settings"
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        style={{
          position: 'fixed',
          zIndex: 'var(--z-modal)',
          top: '50%',
          left: '50%',
          transform: 'translate(-50%, -50%)',
          width: 'min(420px, calc(100vw - 32px))',
          maxHeight: 'calc(100vh - 64px)',
          overflowY: 'auto',
          background: 'var(--surface)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius-md)',
          boxShadow: '0 8px 40px rgba(0,0,0,0.6)',
        }}
      >
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '10px 12px',
          borderBottom: '1px solid var(--border-subtle)',
        }}>
          <span style={{ flex: 1, fontSize: 13, fontWeight: 600, color: 'var(--text)' }}>
            settings
          </span>
          <button
            className="btn-ghost"
            data-testid="settings-close"
            onClick={onClose}
            aria-label="Close settings"
            title="Close settings"
            style={stepper}
          >
            ×
          </button>
        </div>

        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '12px',
        }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13, color: 'var(--text)' }}>terminal text size</div>
            <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 2 }}>
              this device only
            </div>
          </div>
          <button
            className="btn-outline"
            data-testid="font-size-down"
            onClick={() => onFontSizeChange(fontSize - 1)}
            disabled={fontSize <= MIN_FONT_SIZE}
            aria-label="Smaller text"
            title="Smaller text"
            style={stepper}
          >
            −
          </button>
          <span
            data-testid="font-size-value"
            style={{ minWidth: 24, textAlign: 'center', fontSize: 12, color: 'var(--text-dim)' }}
          >
            {fontSize}
          </span>
          <button
            className="btn-outline"
            data-testid="font-size-up"
            onClick={() => onFontSizeChange(fontSize + 1)}
            disabled={fontSize >= MAX_FONT_SIZE}
            aria-label="Larger text"
            title="Larger text"
            style={stepper}
          >
            +
          </button>
        </div>
      </div>
    </>
  )
}
