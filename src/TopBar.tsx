import { displayName } from './sessionState'
import type { Session } from './sessionState'
import type { MobileView } from './mobile'
import type { CSSProperties } from 'react'

interface TopBarProps {
  isMobile: boolean
  sidebarOpen: boolean
  onToggleSidebar: () => void
  activeSessionData: Session | undefined
  mobileView: MobileView
  onSetMobileView: (view: MobileView) => void
  filePanelOpen: boolean
  onToggleFilePanel: () => void
  /** Desktop only: whether the key toolbar is showing (off by default next to a physical keyboard). */
  toolbarVisible: boolean
  onToggleToolbar: () => void
}

export function TopBar({
  isMobile,
  sidebarOpen,
  onToggleSidebar,
  activeSessionData,
  mobileView,
  onSetMobileView,
  filePanelOpen,
  onToggleFilePanel,
  toolbarVisible,
  onToggleToolbar,
}: TopBarProps) {
  const sidebarLabel = sidebarOpen ? 'Close sidebar' : 'Open sidebar'
  return (
    <div
      className="top-bar"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: isMobile ? 4 : 8,
        paddingRight: isMobile ? 8 : 12,
        paddingBottom: isMobile ? 4 : 8,
        paddingLeft: isMobile ? 4 : 12,
        // The top padding is set in styles.css (.top-bar), which adds the
        // safe-area inset unless the version banner above owns it.
        '--top-bar-pad': isMobile ? '4px' : '8px',
        background: 'var(--surface)',
        borderBottom: '1px solid var(--border)',
        minHeight: 'var(--hit)',
      } as CSSProperties}
    >
      {/* Sidebar toggle: hamburger on mobile, collapse arrow on desktop */}
      <button
        className="btn-ghost"
        data-testid="sidebar-toggle"
        onClick={onToggleSidebar}
        aria-label={sidebarLabel}
        title={sidebarLabel}
        style={{
          fontSize: isMobile ? 20 : 14,
          padding: isMobile ? 0 : '4px 6px',
          minWidth: isMobile ? 'var(--hit)' : undefined,
          minHeight: isMobile ? 'var(--hit)' : undefined,
        }}
      >
        {isMobile ? '☰' : (sidebarOpen ? '◂' : '▸')}
      </button>

      <div style={{
        flex: 1,
        minWidth: 0,
        display: 'flex',
        flexDirection: isMobile ? 'column' : 'row',
        alignItems: isMobile ? 'flex-start' : 'baseline',
        gap: isMobile ? 0 : 8,
        overflow: 'hidden',
      }}>
        <span style={{
          fontSize: 13,
          color: 'var(--accent)',
          fontWeight: 600,
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          maxWidth: '100%',
        }}>
          &rsaquo; {activeSessionData ? displayName(activeSessionData) : ''}
        </span>
        <span style={{
          fontSize: isMobile ? 10 : 12,
          color: 'var(--text-dim)',
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          maxWidth: '100%',
          minWidth: 0,
        }}>
          {activeSessionData?.cwd}
        </span>
      </div>

      {/* Mobile view switch: terminal or files, one pressed at a time */}
      {isMobile && (
        <div
          role="group"
          aria-label="View"
          style={{
            display: 'flex',
            gap: 2,
            background: 'var(--surface-raised)',
            borderRadius: 'var(--radius-lg)',
            padding: 2,
            flexShrink: 0,
          }}
        >
          {(['terminal', 'files'] as const).map(view => (
            <button
              key={view}
              className="btn-ghost"
              onClick={() => onSetMobileView(view)}
              aria-pressed={mobileView === view}
              style={{ padding: '0 12px', minHeight: 36 }}
            >
              {view === 'terminal' ? 'term' : 'files'}
            </button>
          ))}
        </div>
      )}

      {/* Desktop key toolbar toggle: off by default next to a real keyboard */}
      {!isMobile && (
        <button
          className="btn-outline"
          data-testid="keytoolbar-toggle"
          onClick={onToggleToolbar}
          aria-pressed={toolbarVisible}
          title={toolbarVisible ? 'Hide key toolbar' : 'Show key toolbar'}
          style={{ borderRadius: 'var(--radius-sm)' }}
        >
          keys
        </button>
      )}

      {/* Desktop file panel toggle */}
      {!isMobile && (
        <button
          className="btn-outline"
          data-testid="files-toggle"
          onClick={onToggleFilePanel}
          aria-pressed={filePanelOpen}
          title={filePanelOpen ? 'Hide file panel' : 'Show file panel'}
          style={{ borderRadius: 'var(--radius-sm)' }}
        >
          files
        </button>
      )}
    </div>
  )
}
