import { MONO_FONT } from './theme'
import { displayName } from './sessionState'
import type { Session } from './sessionState'
import type { MobileView } from './App'

interface TopBarProps {
  isMobile: boolean
  sidebarOpen: boolean
  onToggleSidebar: () => void
  activeSessionData: Session | undefined
  mobileView: MobileView
  onSetMobileView: (view: MobileView) => void
  filePanelOpen: boolean
  onToggleFilePanel: () => void
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
}: TopBarProps) {
  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      gap: isMobile ? 4 : 8,
      padding: isMobile ? '4px 8px 4px 4px' : '8px 12px',
      paddingTop: `calc(${isMobile ? 4 : 8}px + env(safe-area-inset-top))`,
      background: 'var(--surface)',
      borderBottom: '1px solid var(--border)',
      minHeight: 44,
    }}>
      {/* Sidebar toggle: hamburger on mobile, collapse arrow on desktop */}
      <button
        data-testid="sidebar-toggle"
        onClick={onToggleSidebar}
        aria-label={sidebarOpen ? 'Close sidebar' : 'Open sidebar'}
        style={{
          background: 'none',
          border: 'none',
          color: 'var(--text-dim)',
          fontSize: isMobile ? 20 : 14,
          cursor: 'pointer',
          padding: isMobile ? 0 : '4px 6px',
          minWidth: isMobile ? 44 : undefined,
          minHeight: isMobile ? 44 : undefined,
          fontFamily: MONO_FONT,
        }}
        title={sidebarOpen ? 'Collapse sidebar' : 'Expand sidebar'}
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
          fontFamily: MONO_FONT,
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
          fontFamily: MONO_FONT,
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

      {/* Mobile view toggle */}
      {isMobile && (
        <div style={{
          display: 'flex',
          gap: 2,
          background: 'var(--surface-raised)',
          borderRadius: 8,
          padding: 2,
          flexShrink: 0,
        }}>
          {(['terminal', 'files'] as const).map(view => (
            <button
              key={view}
              onClick={() => onSetMobileView(view)}
              style={{
                background: mobileView === view ? 'var(--accent-dim)' : 'transparent',
                border: 'none',
                color: mobileView === view ? 'var(--accent)' : 'var(--text-dim)',
                fontSize: 12,
                padding: '0 12px',
                minHeight: 36,
                borderRadius: 6,
                cursor: 'pointer',
                fontFamily: MONO_FONT,
              }}
            >
              {view === 'terminal' ? 'term' : 'files'}
            </button>
          ))}
        </div>
      )}

      {/* Desktop file panel toggle */}
      {!isMobile && (
        <button
          data-testid="files-toggle"
          onClick={onToggleFilePanel}
          style={{
            background: filePanelOpen ? 'var(--accent-dim)' : 'transparent',
            border: `1px solid ${filePanelOpen ? 'var(--accent)' : 'var(--border)'}`,
            color: filePanelOpen ? 'var(--accent)' : 'var(--text-dim)',
            fontSize: 12,
            padding: '4px 10px',
            borderRadius: 4,
            cursor: 'pointer',
            fontFamily: MONO_FONT,
          }}
        >
          files
        </button>
      )}
    </div>
  )
}
