import { useEffect, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import { displayName, sortSessions, type Session } from './sessionState'
import { isEditableTarget, useEscape } from './hooks/useEscape'
import { relativeTime, showsAgent, visiblePast } from './pastSessionsView'
import { PAST_SESSIONS_KEY, storageGet, storageSet } from './storage'
import type { PastSession } from './shared/protocol'

interface SidebarProps {
  sessions: Session[]
  activeSession: number | null
  onSelect: (id: number) => void
  onCreate: () => void
  onKill: (id: number) => void
  onRename: (id: number, name: string) => void
  /** Past agent sessions on disk, newest first; null while the first scan is pending. */
  pastSessions?: PastSession[] | null
  /** Open a new session resuming a past one. */
  onRevive?: (agent: string, sessionId: string) => void
  /** Close the drawer (mobile only; desktop uses the top-bar toggle). */
  onClose: () => void
  isOpen: boolean
  isMobile: boolean
  /** windowId -> number of attached clients, from session:ownership. */
  ownership?: Record<number, number>
  /** Session the leader key asked to rename, or null. See onRenameRequestHandled. */
  renameRequest?: number | null
  /** Called once the inline editor is open, so App can drop the request. */
  onRenameRequestHandled?: () => void
  /** Open the settings modal; the gear sits in the footer. */
  onOpenSettings: () => void
}

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
  pastSessions = null,
  onRevive,
  onClose,
  isOpen,
  isMobile,
  ownership = {},
  renameRequest = null,
  onRenameRequestHandled,
  onOpenSettings,
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

  // The past-sessions section folds away and remembers it; "show more"
  // does not, so a long list is short again next time.
  const [pastOpen, setPastOpen] = useState(() => storageGet(PAST_SESSIONS_KEY) === 'true')
  const [pastExpanded, setPastExpanded] = useState(false)
  const togglePast = () => {
    setPastOpen(open => {
      storageSet(PAST_SESSIONS_KEY, open ? 'false' : 'true')
      return !open
    })
  }
  const past = visiblePast(pastSessions ?? [], pastExpanded)
  const showAgent = showsAgent(pastSessions ?? [])
  const now = Date.now()
  /** The live Foray session a running past session is in, if it is one of ours. */
  const liveWindowFor = (row: PastSession): Session | undefined =>
    row.liveIn === undefined ? undefined : sessions.find(s => s.name === row.liveIn)

  // The drawer is a modal layer: Escape closes it, and keyboard focus
  // moves in while it is open and back out when it closes. Focus is not
  // handed back to a text field, since on a phone that would raise the
  // soft keyboard the user did not ask for. The Composer is the exception:
  // the keyboard was up when the drawer opened, so it comes back with it.
  const drawerOpen = isMobile && isOpen
  useEscape(onClose, drawerOpen)
  const drawerRef = useRef<HTMLDivElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (!drawerOpen) return
    const previous = document.activeElement as HTMLElement | null
    closeRef.current?.focus()
    return () => {
      if (drawerRef.current?.contains(document.activeElement)) (document.activeElement as HTMLElement | null)?.blur()
      if (!previous || !previous.isConnected || previous === document.body) return
      if (!isEditableTarget(previous) || previous.closest('[data-composer]')) previous.focus()
    }
  }, [drawerOpen])

  const startRename = (session: Session) => {
    setRenamingId(session.id)
    setDraft(displayName(session))
  }

  // A rename asked for from outside (the leader key's "r"). App opens the
  // sidebar in the same step, so on desktop this fires as the drawer
  // mounts; clearing the request keeps a later open from re-triggering it.
  useEffect(() => {
    if (renameRequest === null) return
    const session = sessions.find(s => s.id === renameRequest)
    if (session) startRename(session)
    onRenameRequestHandled?.()
    // startRename only sets state, so it does not belong in the deps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [renameRequest, sessions, onRenameRequestHandled])

  if (!isMobile && !isOpen) return null

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
  const hit = isMobile ? 'var(--hit)' : 30

  // Square icon buttons: the look is .btn-ghost, this is only the size.
  const iconButton = (fontSize: number): React.CSSProperties => ({
    padding: 0,
    minWidth: hit,
    minHeight: hit,
    flexShrink: 0,
    fontSize,
  })

  return (
    <div ref={drawerRef} data-testid="sidebar" aria-hidden={isMobile && !isOpen ? true : undefined} style={{
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
        zIndex: 'var(--z-drawer)',
        paddingTop: 'env(safe-area-inset-top)',
        paddingBottom: 'env(safe-area-inset-bottom)',
        transform: isOpen ? 'translateX(0)' : 'translateX(-100%)',
        // Off-screen is not hidden: without this the closed drawer is still
        // focusable, read by screen readers and "visible" to automation.
        // visibility flips at once on open (the focus move above needs the
        // close button focusable right away) and after the slide-out on close.
        visibility: isOpen ? 'visible' : 'hidden',
        transition: isOpen ? 'transform 0.2s ease' : 'transform 0.2s ease, visibility 0s 0.2s',
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
          }}>
            foray
          </div>
          <div style={{
            fontSize: 11,
            color: 'var(--text-faint)',
            marginTop: 2,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}>
            {window.location.host}
          </div>
        </div>
        {isMobile && (
          <button
            ref={closeRef}
            className="btn-ghost"
            data-testid="sidebar-close"
            onClick={onClose}
            aria-label="Close sidebar"
            title="Close sidebar"
            style={iconButton(18)}
          >
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
        color: 'var(--text-dim)',
      }}>
        Sessions
      </div>

      {/* Session list */}
      <div data-testid="session-list" style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '0 8px', overscrollBehavior: 'contain' }}>
        {sortSessions(sessions).map(session => {
          const active = session.id === activeSession
          const renaming = renamingId === session.id
          const armed = confirmKillId === session.id
          const killLabel = armed ? 'Confirm kill session' : 'Kill session'
          return (
            <div
              key={session.id}
              data-testid="session-row"
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
                  className="field"
                  data-testid="session-name-input"
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
                  }}
                />
              ) : (
                <button
                  className="btn-ghost"
                  data-testid="session-item"
                  data-session-id={session.id}
                  data-active={active ? 'true' : 'false'}
                  aria-current={active ? 'true' : undefined}
                  title={displayName(session)}
                  onClick={() => onSelect(session.id)}
                  style={{
                    flex: 1,
                    minWidth: 0,
                    minHeight: hit,
                    justifyContent: 'flex-start',
                    gap: 10,
                    padding: '6px 12px',
                    textAlign: 'left',
                    whiteSpace: 'normal',
                  }}
                >
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 6,
                      fontSize: 13,
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
                            background: 'var(--accent)',
                          }}
                        />
                      )}
                    </div>
                    <div style={{
                      fontSize: 11,
                      color: 'var(--text-dim)',
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
                    className="btn-ghost tone-accent"
                    onMouseDown={e => e.preventDefault()}
                    onClick={commitRename}
                    title="Save name"
                    aria-label="Save name"
                    style={iconButton(14)}
                  >
                    ✓
                  </button>
                  <button
                    className="btn-ghost"
                    onMouseDown={e => e.preventDefault()}
                    onClick={cancelRename}
                    title="Cancel rename"
                    aria-label="Cancel rename"
                    style={iconButton(14)}
                  >
                    ✕
                  </button>
                </>
              ) : (
                <>
                  <button
                    className="btn-ghost"
                    data-testid="session-rename"
                    onClick={() => startRename(session)}
                    title="Rename session"
                    aria-label="Rename session"
                    style={iconButton(13)}
                  >
                    ✎
                  </button>
                  <button
                    className={armed ? 'btn-ghost tone-danger' : 'btn-ghost'}
                    data-testid="session-kill"
                    onClick={() => handleKill(session)}
                    title={killLabel}
                    aria-label={killLabel}
                    style={armed ? { ...iconButton(11), fontWeight: 600, padding: '0 8px' } : iconButton(15)}
                  >
                    {armed ? 'kill?' : '×'}
                  </button>
                </>
              )}
            </div>
          )
        })}
      </div>

      {/* Past sessions: agent transcripts on disk, one tap to resume. */}
      <div data-testid="past-sessions" style={{
        borderTop: '1px solid var(--border-subtle)',
        display: 'flex',
        flexDirection: 'column',
        flexShrink: 0,
        maxHeight: '45%',
        minHeight: 0,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', flexShrink: 0 }}>
        <button
          className="btn-ghost"
          data-testid="past-sessions-toggle"
          aria-expanded={pastOpen}
          onClick={togglePast}
          style={{
            flex: 1,
            minWidth: 0,
            justifyContent: 'space-between',
            padding: '8px 16px',
            minHeight: hit,
            borderRadius: 0,
          }}
        >
          <span style={{
            fontSize: 10,
            fontWeight: 600,
            textTransform: 'uppercase',
            letterSpacing: '0.1em',
            color: 'var(--text-dim)',
          }}>
            Past sessions{pastSessions && pastSessions.length > 0 ? ` · ${pastSessions.length}` : ''}
          </span>
          <span aria-hidden style={{ fontSize: 11, color: 'var(--text-dim)' }}>{pastOpen ? '▾' : '▸'}</span>
        </button>
        <button
          className="btn-ghost"
          data-testid="settings-open"
          onClick={onOpenSettings}
          aria-label="Settings"
          title="Settings"
          style={{ ...iconButton(14), borderRadius: 0 }}
        >
          ⚙
        </button>
        </div>
        {pastOpen && (
          <div data-testid="past-session-list" style={{ overflowY: 'auto', minHeight: 0, padding: '0 8px 8px', overscrollBehavior: 'contain' }}>
            {pastSessions === null || pastSessions.length === 0 ? (
              <div style={{ padding: '4px 12px 8px', fontSize: 12, color: 'var(--text-faint)' }}>
                {pastSessions === null ? 'scanning…' : 'no past sessions'}
              </div>
            ) : (
              <>
                {past.shown.map(row => {
                  const liveWindow = liveWindowFor(row)
                  // A running session cannot be resumed (that would fork it);
                  // when it lives in one of our sessions the row jumps there.
                  const disabled = row.live && !liveWindow
                  const hint = row.live
                    ? liveWindow ? `Running in "${displayName(liveWindow)}" — open it` : 'Running outside Foray'
                    : `Resume: ${row.lastPrompt || row.title}`
                  return (
                    <button
                      key={`${row.agent}:${row.id}`}
                      className="btn-ghost"
                      data-testid="past-session-item"
                      data-live={row.live ? 'true' : 'false'}
                      disabled={disabled}
                      title={hint}
                      aria-label={row.live ? `Open ${row.title}` : `Resume ${row.title}`}
                      onClick={() => {
                        if (liveWindow) onSelect(liveWindow.id)
                        else if (!row.live) onRevive?.(row.agent, row.id)
                      }}
                      style={{
                        width: '100%',
                        minHeight: hit,
                        justifyContent: 'flex-start',
                        gap: 10,
                        padding: '6px 12px',
                        marginBottom: 2,
                        textAlign: 'left',
                        whiteSpace: 'normal',
                        // The dimmed title already says "not clickable"; the
                        // disabled half-opacity on top made it unreadable.
                        opacity: 1,
                      }}
                    >
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 6,
                          fontSize: 13,
                          color: row.live ? 'var(--text-dim)' : 'var(--text)',
                          overflow: 'hidden',
                        }}>
                          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {row.title}
                          </span>
                          {row.live && (
                            <span style={{
                              flexShrink: 0,
                              fontSize: 9,
                              fontWeight: 600,
                              letterSpacing: '0.08em',
                              textTransform: 'uppercase',
                              color: 'var(--accent)',
                              border: '1px solid var(--accent-dim)',
                              borderRadius: 'var(--radius-sm)',
                              padding: '0 4px',
                            }}>
                              live
                            </span>
                          )}
                          {showAgent && (
                            <span style={{ flexShrink: 0, fontSize: 10, color: 'var(--text-faint)' }}>
                              {row.agentLabel}
                            </span>
                          )}
                        </div>
                        <div style={{
                          fontSize: 11,
                          color: 'var(--text-dim)',
                          marginTop: 1,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}>
                          {shortenPath(row.cwd)} · {relativeTime(row.lastActive, now)}
                        </div>
                      </div>
                    </button>
                  )
                })}
                {past.hidden > 0 && (
                  <button
                    className="btn-ghost"
                    data-testid="past-sessions-more"
                    onClick={() => setPastExpanded(true)}
                    style={{ width: '100%', minHeight: hit, fontSize: 12, color: 'var(--text-dim)' }}
                  >
                    show {past.hidden} more
                  </button>
                )}
              </>
            )}
          </div>
        )}
      </div>

      {/* New session */}
      <div style={{
        padding: '8px',
        borderTop: '1px solid var(--border-subtle)',
      }}>
        <button
          className="btn-outline"
          data-testid="new-session"
          onClick={onCreate}
          style={{
            width: '100%',
            padding: '8px',
            minHeight: isMobile ? 'var(--hit)' : undefined,
            borderStyle: 'dashed',
            borderColor: 'var(--text-faint)',
          }}
        >
          + new session
        </button>
      </div>

    </div>
  )
}
