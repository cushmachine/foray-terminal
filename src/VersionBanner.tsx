import type { VersionNotice } from './version'

interface VersionBannerProps {
  notice: VersionNotice | null
  onReload: () => void
  onDismiss: () => void
}

/**
 * A strip at the top of the main column while the server and this page
 * disagree about versions. In the layout, not over it: the top bar moves
 * down rather than being covered (styles.css hands it the safe-area inset).
 */
export function VersionBanner({ notice, onReload, onDismiss }: VersionBannerProps) {
  if (!notice) return null
  return (
    <div
      className="version-banner"
      data-testid="version-banner"
      role="status"
      style={{
        flexShrink: 0,
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 10,
        background: 'var(--surface)',
        borderBottom: '1px solid var(--accent)',
        color: 'var(--text)',
        fontSize: 12,
      }}
    >
      <span>{notice.text}</span>
      {notice.kind === 'stale-page' && (
        <button className="btn-outline tone-accent" onClick={onReload}>reload</button>
      )}
      <button className="btn-outline tone-accent" onClick={onDismiss} aria-label="Dismiss" title="Dismiss">×</button>
    </div>
  )
}
