import { useEffect, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import { displayName, type Session } from './sessionState'
import { MAX_FONT_SIZE, MIN_FONT_SIZE } from './mobile'

interface SidebarProps {
  sessions: Session[]
  activeSession: number | null
  onSelect: (id: number) => void
  onCreate: () => void
  onKill: (id: number) => void
  onRename: (id: number, name: string) => void
  /** Close the drawer (mobile only; desktop uses the top-bar toggle). */
  onClose: () => void
  isOpen: boolean
  isMobile: boolean
  /** windowId -> number of attached clients, from session:ownership. */
  ownership?: Record<number, number>
  fontSize: number
  onFontSizeChange: (size: number) => void
}

const MONO = "'JetBrains Mono', monospace"

/** How long the "kill?" confirmation stays armed before reverting. */
const KILL_CONFIRM_MS = 3000

/** Shortens a home-directory path the way a shell prompt would (~/foo). */
function shortenPath(cwd: string): string {
  const match = cwd.match(/^\/(?:Users|home)\/[^/]+(\/.*)?$/)
  if (!match) return cwd
  return `~${match[1] ?? ''}`
}

export function Sidebar({
  sessions,
  activeSession,
  onSelect,
  onCreate,
  onKill,
  onRename,
  onClose,
  isOpen,
  isMobile,
  ownership = {},
  fontSize,
  onFontSizeChange,
}: SidebarProps) {
  // Inline rename replaces window.prompt, which is ugly in a Home Screen
  // app and blocked outright in some Android webviews.
  const [renamingId, setRenamingId] = useState<number | null>(null)
  const [draft, setDraft] = useState('')
  // Two-tap kill replaces window.confirm: the first tap arms the button,
  // a second tap within KILL_CONFIRM_MS kills.
  const [confirmKillId, setConfirmKillId] = useState<number | null>(null)

  useEffect(() => {
    if (confirmKillId === null) return
    const timer = setTimeout(() => setConfirmKillId(null), KILL_CONFIRM_MS)
    return () => clearTimeout(timer)
  }, [confirmKillId])

  if (!isMobile && !isOpen) return null

  const startRename = (session: Session) => {
    setRenamingId(session.id)
    setDraft(displayName(session))
  }

  const commitRename = () => {
    if (renamingId === null) return
    const session = sessions.find(s => s.id === renamingId)
    const name = draft.trim()
    if (session && name && name !== session.name) onRename(session.id, name)
    setRenamingId(null)
  }

  const cancelRename = () => setRenamingId(null)

  const handleRenameKey = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') commitRename()
    if (e.key === 'Escape') cancelRename()
  }

  const handleKill = (session: Session) => {
    if (confirmKillId === session.id) {
      setConfirmKillId(null)
      onKill(session.id)
    } else {
      setConfirmKillId(session.id)
    }
  }

  // Touch targets: 44px on phones, compact on desktop.
  const hit = isMobile ? 44 : 30

  const iconButton = (extra: React.CSSProperties = {}): React.CSSProperties => ({
    background: 'none',
    border: 'none',
    color: 'var(--text-faint)',
    cursor: 'pointer',
    padding: 0,
    minWidth: hit,
    minHeight: hit,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    borderRadius: 6,
    fontFamily: MONO,
    ...extra,
  })

  return (
    <div style={{
      width: isMobile ? 'min(300px, 85vw)' : 'var(--sidebar-width)',
      background: 'var(--surface)',
      borderRight: '1px solid var(--border)',
      display: 'flex',
      flexDirection: 'column',
      flexShrink: 0,
      ...(isMobile ? {
        position: 'fixed' as const,
        left: 0,
        top: 0,
        bottom: 0,
        zIndex: 100,
        paddingTop: 'env(safe-area-inset-top)',
        paddingBottom: 'env(safe-area-inset-bottom)',
        transform: isOpen ? 'translateX(0)' : 'translateX(-100%)',
        transition: 'transform 0.2s ease',
        boxShadow: isOpen ? '0 0 32px rgba(0,0,0,0.5)' : 'none',
      } : {}),
    }}>
      {/* Header */}
      <div style={{
        padding: isMobile ? '12px 8px 10px 16px' : '16px 16px 12px',
        borderBottom: '1px solid var(--border-subtle)',
        display: 'flex',
        alignItems: 'center',
        gap: 8,
      }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{
            fontSize: 15,
            fontWeight: 700,
            letterSpacing: '0.04em',
            color: 'var(--accent)',
            fontFamily: MONO,
          }}>
            nest
          </div>
          <div style={{
            fontSize: 11,
            color: 'var(--text-faint)',
            marginTop: 2,
            fontFamily: MONO,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}>
            {window.location.host}
          </div>
        </div>
        {isMobile && (
          <button onClick={onClose} aria-label="Close sidebar" style={iconButton({ fontSize: 18 })}>
            ‹
          </button>
        )}
      </div>

      {/* Sessions label */}
      <div style={{
        padding: '12px 16px 6px',
        fontSize: 10,
        fontWeight: 600,
        textTransform: 'uppercase',
        letterSpacing: '0.1em',
        color: 'var(--text-faint)',
      }}>
        Sessions
      </div>

      {/* Session list */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '0 8px', overscrollBehavior: 'contain' }}>
        {sessions.map(session => {
          const active = session.id === activeSession
          const renaming = renamingId === session.id
          const armed = confirmKillId === session.id
          return (
            <div
              key={session.id}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 2,
                marginBottom: 2,
              }}
            >
              {renaming ? (
                <input
                  autoFocus
                  value={draft}
                  onChange={e => setDraft(e.target.value)}
                  onKeyDown={handleRenameKey}
                  onBlur={commitRename}
                  aria-label="Session name"
                  autoCapitalize="off"
                  autoCorrect="off"
                  spellCheck={false}
                  style={{
                    flex: 1,
                    minWidth: 0,
                    minHeight: hit,
                    padding: '0 10px',
                    background: 'var(--surface-raised)',
                    border: '1px solid var(--accent)',
                    borderRadius: 6,
                    color: 'var(--text)',
                    fontSize: 13,
                    fontFamily: MONO,
                    outline: 'none',
                  }}
                />
              ) : (
                <button
                  onClick={() => onSelect(session.id)}
                  style={{
                    flex: 1,
                    minWidth: 0,
                    minHeight: hit,
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                    padding: '6px 12px',
                    background: active ? 'var(--surface-hover)' : 'transparent',
                    border: 'none',
                    borderRadius: 6,
                    cursor: 'pointer',
                    textAlign: 'left',
                    transition: 'background 0.1s',
                  }}
                >
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 6,
                      fontSize: 13,
                      fontFamily: MONO,
                      color: active ? 'var(--accent)' : 'var(--text)',
                      fontWeight: active ? 600 : 400,
                      overflow: 'hidden',
                    }}>
                      <span style={{
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}>
                        {displayName(session)}
                      </span>
                      {(ownership[session.id] ?? 0) > 1 && (
                        <span
                          title={`${ownership[session.id]} clients attached — attaching here will take over`}
                          style={{
                            flexShrink: 0,
                            width: 6,
                            height: 6,
                            borderRadius: '50%',
                            background: 'var(--accent, #3db8a9)',
                          }}
                        />
                      )}
                    </div>
                    <div style={{
                      fontSize: 11,
                      color: 'var(--text-dim)',
                      fontFamily: MONO,
                      marginTop: 1,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}>
                      {shortenPath(session.cwd)}
                    </div>
                  </div>
                </button>
              )}

              {renaming ? (
                <>
                  <button
                    onMouseDown={e => e.preventDefault()}
                    onClick={commitRename}
                    title="save name"
                    aria-label="Save name"
                    style={iconButton({ color: 'var(--accent)', fontSize: 14 })}
                  >
                    ✓
                  </button>
                  <button
                    onMouseDown={e => e.preventDefault()}
                    onClick={cancelRename}
                    title="cancel"
                    aria-label="Cancel rename"
                    style={iconButton({ fontSize: 14 })}
                  >
                    ✕
                  </button>
                </>
              ) : (
                <>
                  <button
                    onClick={() => startRename(session)}
                    title="rename session"
                    aria-label="Rename session"
                    style={iconButton({ fontSize: 13 })}
                  >
                    ✎
                  </button>
                  <button
                    onClick={() => handleKill(session)}
                    title={armed ? 'tap again to kill' : 'kill session'}
                    aria-label={armed ? 'Confirm kill session' : 'Kill session'}
                    style={iconButton(armed ? {
                      color: 'var(--danger)',
                      background: 'rgba(212, 99, 79, 0.15)',
                      fontSize: 11,
                      fontWeight: 600,
                      padding: '0 8px',
                    } : { fontSize: 15 })}
                  >
                    {armed ? 'kill?' : '×'}
                  </button>
                </>
              )}
            </div>
          )
        })}
      </div>

      {/* New session */}
      <div style={{
        padding: '8px',
        borderTop: '1px solid var(--border-subtle)',
      }}>
        <button
          onClick={onCreate}
          style={{
            width: '100%',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 6,
            padding: '8px',
            minHeight: isMobile ? 44 : undefined,
            background: 'transparent',
            border: '1px dashed var(--border)',
            borderRadius: 6,
            color: 'var(--text-dim)',
            fontSize: 12,
            cursor: 'pointer',
            fontFamily: MONO,
          }}
        >
          + new session
        </button>
      </div>

      {/* Terminal text size */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: 4,
        padding: '4px 8px 8px',
        fontFamily: MONO,
        fontSize: 11,
        color: 'var(--text-faint)',
      }}>
        <span style={{ flex: 1, paddingLeft: 8 }}>text size</span>
        <button
          onClick={() => onFontSizeChange(fontSize - 1)}
          disabled={fontSize <= MIN_FONT_SIZE}
          aria-label="Smaller text"
          style={iconButton({ color: 'var(--text-dim)', fontSize: 15, border: '1px solid var(--border)' })}
        >
          −
        </button>
        <span style={{ minWidth: 24, textAlign: 'center', color: 'var(--text-dim)' }}>{fontSize}</span>
        <button
          onClick={() => onFontSizeChange(fontSize + 1)}
          disabled={fontSize >= MAX_FONT_SIZE}
          aria-label="Larger text"
          style={iconButton({ color: 'var(--text-dim)', fontSize: 15, border: '1px solid var(--border)' })}
        >
          +
        </button>
      </div>
    </div>
  )
}
