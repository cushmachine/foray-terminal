import { MONO_FONT } from './theme'
import type { VersionNotice } from './version'

interface VersionBannerProps {
  notice: VersionNotice | null
  onReload: () => void
  onDismiss: () => void
}

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

/** Fixed strip at the top of the page while the server and this page disagree about versions. */
export function VersionBanner({ notice, onReload, onDismiss }: VersionBannerProps) {
  if (!notice) return null
  return (
    <div
      role="status"
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        zIndex: 200,
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 10,
        padding: '6px 12px',
        paddingTop: 'calc(6px + env(safe-area-inset-top))',
        background: 'var(--surface)',
        borderBottom: '1px solid var(--accent)',
        color: 'var(--text)',
        fontFamily: MONO_FONT,
        fontSize: 12,
      }}
    >
      <span>{notice.text}</span>
      {notice.kind === 'stale-page' && (
        <button onClick={onReload} style={buttonStyle}>reload</button>
      )}
      <button onClick={onDismiss} aria-label="Dismiss" style={buttonStyle}>×</button>
    </div>
  )
}
