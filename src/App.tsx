import { useState, useCallback, useEffect, useRef } from 'react'
import type { TouchEvent as ReactTouchEvent } from 'react'
import { Sidebar } from './Sidebar'
import { Terminal } from './Terminal'
import { KeyToolbar } from './KeyToolbar'
import { Composer } from './Composer'
import { FilePanel } from './FilePanel'
import { useSocket } from './hooks/useSocket'
import { useAppHeight } from './hooks/useAppHeight'
import { applySessionMessage, displayName, openedWith, type Session } from './sessionState'
import { NO_MODIFIERS, type Modifiers } from './keys'
import {
  FONT_SIZE_KEY,
  MOBILE_MEDIA_QUERY,
  clampFontSize,
  defaultFontSize,
  isMobileViewport,
  readFontSize,
  swipeAction,
  type Point,
} from './mobile'

export type { Session }
export type MobileView = 'terminal' | 'files'

const MONO = "'JetBrains Mono', monospace"

function detectMobile(): boolean {
  if (typeof window === 'undefined') return false
  if (typeof window.matchMedia === 'function') return window.matchMedia(MOBILE_MEDIA_QUERY).matches
  return isMobileViewport({ width: window.innerWidth, height: window.innerHeight, coarse: false })
}

/**
 * Phone layout or desktop layout. Driven by a media query rather than a
 * bare width check so a phone held in landscape (wide but very short, with
 * a touch pointer) still gets the drawer sidebar instead of losing a third
 * of its height to a fixed one.
 */
function useIsMobile() {
  const [isMobile, setIsMobile] = useState(detectMobile)
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return
    const mql = window.matchMedia(MOBILE_MEDIA_QUERY)
    const handler = () => setIsMobile(mql.matches)
    handler()
    mql.addEventListener('change', handler)
    return () => mql.removeEventListener('change', handler)
  }, [])
  return isMobile
}

// localStorage throws in some private-browsing and embedded contexts;
// treat it as absent rather than crashing the app over a font size.
function storageGet(key: string): string | null {
  try {
    return window.localStorage.getItem(key)
  } catch {
    return null
  }
}

function storageSet(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value)
  } catch {
    // Nothing to do: the size just won't persist.
  }
}

function useFontSize(isMobile: boolean): [number, (size: number) => void] {
  const [fontSize, setFontSizeState] = useState(() =>
    readFontSize(storageGet(FONT_SIZE_KEY), defaultFontSize(isMobile)),
  )
  const setFontSize = useCallback((size: number) => {
    const next = clampFontSize(size)
    setFontSizeState(next)
    storageSet(FONT_SIZE_KEY, String(next))
  }, [])
  return [fontSize, setFontSize]
}

export function App() {
  const socket = useSocket()
  const { onMessage, send, status } = socket

  const [sessions, setSessions] = useState<Session[]>([])
  const [activeSession, setActiveSession] = useState<number | null>(null)
  // Sessions whose terminal has been mounted (see openedWith).
  const [opened, setOpened] = useState<number[]>([])
  // windowId -> number of attached clients, from session:ownership broadcasts.
  const [ownership, setOwnership] = useState<Record<number, number>>({})
  // Desktop starts with the sidebar in view; a phone starts on the terminal.
  const [sidebarOpen, setSidebarOpen] = useState(() => !detectMobile())
  const [filePanelOpen, setFilePanelOpen] = useState(false)
  const [mobileView, setMobileView] = useState<MobileView>('terminal')
  const [openFile, setOpenFile] = useState<string | null>(null)
  const [filePanelWidth, setFilePanelWidth] = useState(320)

  const isMobile = useIsMobile()
  const [fontSize, setFontSize] = useFontSize(isMobile)
  useAppHeight()

  // Mount a terminal for whichever session becomes active.
  useEffect(() => {
    setOpened(prev => openedWith(prev, activeSession))
  }, [activeSession])

  // Route incoming session:* messages into local state via the pure
  // applySessionMessage reducer.
  useEffect(() => {
    return onMessage((msg) => {
      if (msg.type === 'session:list') {
        setSessions(msg.windows)
        setActiveSession(prev => {
          if (prev !== null && msg.windows.some(w => w.id === prev)) return prev
          return msg.windows[0]?.id ?? null
        })
        return
      }
      if (msg.type === 'session:created') {
        setSessions(prev => applySessionMessage(prev, msg))
        // Every client hears about the new session; only the one that asked
        // for it switches to it. Without this, creating a session on one
        // device yanks every other device into it.
        if (!pendingCreate.current) return
        pendingCreate.current = false
        setActiveSession(msg.window.id)
        // A new session's terminal must be visible when it mounts so xterm
        // can measure its font; and you created it to look at it anyway.
        setMobileView('terminal')
        return
      }
      if (msg.type === 'session:killed' || msg.type === 'session:renamed') {
        setSessions(prev => applySessionMessage(prev, msg))
      }
      if (msg.type === 'session:ownership') {
        const next: Record<number, number> = {}
        for (const entry of msg.ownership) next[entry.windowId] = entry.clients
        setOwnership(next)
      }
    })
  }, [onMessage])

  // Toolbar actions reach the active terminal as window events; the
  // toolbar knows nothing about sessions or the socket.
  const sendKeys = useCallback((data: string) => {
    window.dispatchEvent(new CustomEvent('nest:sendkeys', { detail: data }))
  }, [])
  const pasteText = useCallback((text: string) => {
    window.dispatchEvent(new CustomEvent('nest:paste', { detail: text }))
  }, [])
  const uploadFiles = useCallback((files: File[]) => {
    window.dispatchEvent(new CustomEvent('nest:upload', { detail: files }))
  }, [])
  const submitText = useCallback((text: string) => {
    window.dispatchEvent(new CustomEvent('nest:submit', { detail: text }))
  }, [])

  // Sticky Ctrl/Alt from the toolbar. Armed here, applied by the active
  // terminal to its next input, then cleared.
  const [modifiers, setModifiers] = useState<Modifiers>(NO_MODIFIERS)
  const toggleModifier = useCallback((which: 'ctrl' | 'alt') => {
    setModifiers(prev => ({ ...prev, [which]: !prev[which] }))
  }, [])
  const clearModifiers = useCallback(() => setModifiers(NO_MODIFIERS), [])

  const selectSession = useCallback((id: number) => {
    setActiveSession(id)
    if (isMobile) {
      setSidebarOpen(false)
      setMobileView('terminal')
    }
  }, [isMobile])

  const pendingCreate = useRef(false)
  const createSession = useCallback(() => {
    pendingCreate.current = true
    send({ type: 'session:create' })
  }, [send])

  const killSession = useCallback((id: number) => {
    send({ type: 'session:kill', windowId: id })
  }, [send])

  const renameSession = useCallback((id: number, name: string) => {
    send({ type: 'session:rename', windowId: id, name })
  }, [send])

  const handleOpenFile = useCallback((path: string) => {
    setOpenFile(path)
    if (isMobile) {
      setMobileView('files')
    } else {
      setFilePanelOpen(true)
    }
  }, [isMobile])

  const handleCloseFile = useCallback(() => {
    setOpenFile(null)
    if (isMobile) {
      setMobileView('terminal')
    }
  }, [isMobile])

  // Edge swipe opens the drawer; a leftward swipe closes it. Decided on
  // touchend from the start/end points so a scroll in the terminal, which
  // is vertical, never trips it.
  const touchStart = useRef<Point | null>(null)
  const handleTouchStart = (e: ReactTouchEvent) => {
    const t = e.touches[0]
    touchStart.current = t ? { x: t.clientX, y: t.clientY } : null
  }
  const handleTouchEnd = (e: ReactTouchEvent) => {
    const start = touchStart.current
    touchStart.current = null
    const t = e.changedTouches[0]
    if (!start || !t) return
    const action = swipeAction(start, { x: t.clientX, y: t.clientY }, sidebarOpen)
    if (action === 'open') setSidebarOpen(true)
    if (action === 'close') setSidebarOpen(false)
  }

  const activeSessionData = sessions.find(s => s.id === activeSession)

  return (
    <div
      style={{ display: 'flex', height: '100%', width: '100%' }}
      onTouchStart={isMobile ? handleTouchStart : undefined}
      onTouchEnd={isMobile ? handleTouchEnd : undefined}
    >
      {/* Sidebar overlay on mobile */}
      {sidebarOpen && isMobile && (
        <div
          onClick={() => setSidebarOpen(false)}
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.6)',
            zIndex: 90,
          }}
        />
      )}

      <Sidebar
        sessions={sessions}
        activeSession={activeSession}
        onSelect={selectSession}
        onCreate={createSession}
        onKill={killSession}
        onRename={renameSession}
        onClose={() => setSidebarOpen(false)}
        isOpen={sidebarOpen}
        isMobile={isMobile}
        ownership={ownership}
        fontSize={fontSize}
        onFontSizeChange={setFontSize}
      />

      <div style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        minWidth: 0,
      }}>
        {/* Top bar. Owns the top safe-area inset so its surface runs up
            under the status bar / notch instead of leaving a black band. */}
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
            onClick={() => setSidebarOpen(v => !v)}
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
              fontFamily: MONO,
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
              fontFamily: MONO,
              fontSize: 13,
              color: 'var(--accent)',
              fontWeight: 600,
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              maxWidth: '100%',
            }}>
              › {activeSessionData ? displayName(activeSessionData) : ''}
            </span>
            <span style={{
              fontFamily: MONO,
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
                  onClick={() => setMobileView(view)}
                  style={{
                    background: mobileView === view ? 'var(--accent-dim)' : 'transparent',
                    border: 'none',
                    color: mobileView === view ? 'var(--accent)' : 'var(--text-dim)',
                    fontSize: 12,
                    padding: '0 12px',
                    minHeight: 36,
                    borderRadius: 6,
                    cursor: 'pointer',
                    fontFamily: MONO,
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
              onClick={() => setFilePanelOpen(v => !v)}
              style={{
                background: filePanelOpen ? 'var(--accent-dim)' : 'transparent',
                border: `1px solid ${filePanelOpen ? 'var(--accent)' : 'var(--border)'}`,
                color: filePanelOpen ? 'var(--accent)' : 'var(--text-dim)',
                fontSize: 12,
                padding: '4px 10px',
                borderRadius: 4,
                cursor: 'pointer',
                fontFamily: MONO,
              }}
            >
              files
            </button>
          )}
        </div>

        {/* Main content area */}
        <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
          {/* Terminal */}
          <div style={{
            flex: 1,
            minWidth: 0,
            display: (isMobile && mobileView !== 'terminal') ? 'none' : 'block',
          }}>
            {sessions.filter(session => opened.includes(session.id)).map(session => (
              <div
                key={session.id}
                style={{
                  width: '100%',
                  height: '100%',
                  display: session.id === activeSession ? 'block' : 'none',
                }}
              >
                <Terminal
                  windowId={session.id}
                  socket={socket}
                  isActive={session.id === activeSession}
                  fontSize={fontSize}
                  modifiers={modifiers}
                  onModifiersUsed={clearModifiers}
                />
              </div>
            ))}
          </div>

          {/* File panel */}
          {((!isMobile && filePanelOpen) || (isMobile && mobileView === 'files')) && (
            <FilePanel
              openFile={openFile}
              onOpenFile={handleOpenFile}
              onClose={handleCloseFile}
              isMobile={isMobile}
              width={filePanelWidth}
              onResize={setFilePanelWidth}
              cwd={activeSessionData?.cwd ?? ''}
              send={send}
              onMessage={onMessage}
              status={status}
            />
          )}
        </div>

        {/* Mobile input bar: see Composer.tsx for why typing goes here. */}
        {isMobile && mobileView === 'terminal' && (
          <Composer onSubmit={submitText} />
        )}

        {/* Key toolbar */}
        <KeyToolbar
          onSend={sendKeys}
          onPaste={pasteText}
          onUpload={uploadFiles}
          modifiers={modifiers}
          onToggleModifier={toggleModifier}
          isMobile={isMobile}
        />
      </div>
    </div>
  )
}
