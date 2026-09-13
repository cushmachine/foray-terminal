import { useState } from 'react'
import type { VersionActionId, VersionNotice } from './version'

interface VersionBannerProps {
  notice: VersionNotice | null
  /**
   * One handler per action id, as a Record rather than a prop each: add an
   * id to VersionActionId and this fails to compile until App has
   * something for the new banner's button to do. That, plus the notice's
   * required `action`, is why the button below needs no condition — every
   * notice there can ever be has a button, and it works.
   */
  actions: Record<VersionActionId, () => void>
  onDismiss: () => void
}

/**
 * A strip at the top of the main column while the server and this page
 * disagree about versions. In the layout, not over it: the top bar moves
 * down rather than being covered (styles.css hands it the safe-area inset).
 */
export function VersionBanner({ notice, actions, onDismiss }: VersionBannerProps) {
  // The text of the notice whose button has been pressed. Neither action
  // shows anything immediately — a reload, or a deploy starting in a new
  // session — and pressing "sync now" twice would put two vite builds on
  // the box at once, which has OOM-killed sessions here before. A notice
  // with different text is a different situation and is live again.
  const [acted, setActed] = useState<string | null>(null)
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
      <button
        className="btn-outline tone-accent"
        data-testid="version-action"
        disabled={acted === notice.text}
        onClick={() => {
          setActed(notice.text)
          actions[notice.action.id]()
        }}
      >
        {notice.action.label}
      </button>
      <button className="btn-outline tone-accent" onClick={onDismiss} aria-label="Dismiss" title="Dismiss">×</button>
    </div>
  )
}
