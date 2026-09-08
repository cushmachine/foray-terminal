import { useState, useCallback, useEffect, useReducer, useRef } from 'react'
import type { TouchEvent as ReactTouchEvent } from 'react'
import { Sidebar } from './Sidebar'
import { Terminal } from './Terminal'
import { KeyToolbar } from './KeyToolbar'
import { Composer } from './Composer'
import { FilePanel } from './files/FilePanel'
import { useSocket } from './hooks/useSocket'
import { SocketProvider } from './SocketContext'
import { useAppHeight } from './hooks/useAppHeight'
import { NO_SESSIONS, openedWith, reduceSessions } from './sessionState'
import { NO_MODIFIERS, shortcutAction, type Modifiers } from './keys'
import {
  FILE_PANEL_DEFAULT_WIDTH,
  IS_TOUCH,
  clampFontSize,
  defaultFontSize,
  detectMobile,
  readFontSize,
  readToolbarVisible,
  resolvePanels,
  swipeAction,
  useIsMobile,
  type PanelAction,
  type PanelState,
  type Point,
} from './mobile'
import {
  FONT_SIZE_KEY,
  KEY_TOOLBAR_KEY,
  LAST_SESSION_KEY,
  draftKeyFor,
  storageGet,
  storageSet,
} from './storage'
import { terminalRegistry } from './terminalRegistry'
import { TopBar } from './TopBar'
import { Toast, failureText } from './Toast'
import { VersionBanner } from './VersionBanner'
import { readPageBuild, versionNotice, type VersionNotice } from './version'

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

  const [{ sessions, active: activeSession, picked }, dispatchSessions] = useReducer(reduceSessions, NO_SESSIONS)
  // Sessions whose terminal has been mounted (see openedWith).
  const [opened, setOpened] = useState<number[]>([])
  // windowId -> number of attached clients, from session:ownership broadcasts.
  const [ownership, setOwnership] = useState<Record<number, number>>({})
  // Version drift reported by the server (src/version.ts). Dismissing hides
  // a given notice text until the server reports something different.
  const [notice, setNotice] = useState<VersionNotice | null>(null)
  const dismissedNotice = useRef<string | null>(null)
  // Desktop starts with the sidebar in view; a phone starts on the terminal.
  const [panels, setPanels] = useState<PanelState>(() => ({
    sidebarOpen: !detectMobile(),
    filePanelOpen: false,
    mobileView: 'terminal',
  }))
  const { sidebarOpen, filePanelOpen, mobileView } = panels
  // The stored key-toolbar choice; readToolbarVisible turns it into a
  // decision (touch layouts always show it).
  const [toolbarChoice, setToolbarChoice] = useState(() => storageGet(KEY_TOOLBAR_KEY))
  const [openFile, setOpenFile] = useState<string | null>(null)
  const [filePanelWidth, setFilePanelWidth] = useState(FILE_PANEL_DEFAULT_WIDTH)
  // A failure nothing else shows (a rejected session op); see Toast.
  const [toast, setToast] = useState<string | null>(null)
  const dismissToast = useCallback(() => setToast(null), [])

  const isMobile = useIsMobile()
  // Listeners installed once (the socket handler, the keyboard shortcuts)
  // read the current layout through this ref instead of re-subscribing.
  const isMobileRef = useRef(isMobile)
  isMobileRef.current = isMobile
  const [fontSize, setFontSize] = useFontSize(isMobile)
  useAppHeight()

  const toolbarVisible = readToolbarVisible(toolbarChoice, isMobile)
  const toggleToolbar = useCallback(() => {
    setToolbarChoice(prev => {
      const next = readToolbarVisible(prev, false) ? 'false' : 'true'
      storageSet(KEY_TOOLBAR_KEY, next)
      return next
    })
  }, [])

  // Every change to the sidebar, file panel or phone view goes through
  // resolvePanels, which knows the tablet exclusivity rule and what a
  // phone shows after each action.
  const applyPanelAction = useCallback((action: PanelAction) => {
    setPanels(prev => resolvePanels(prev, action, window.innerWidth, isMobileRef.current))
  }, [])

  // Keyboard shortcuts for the chrome (sidebar, file panel). Captured on window so they
  // win over xterm, which otherwise swallows every key while focused.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const action = shortcutAction(e)
      if (!action) return
      e.preventDefault()
      e.stopPropagation()
      applyPanelAction(action)
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [applyPanelAction])

  // Mount a terminal for whichever session becomes active.
  useEffect(() => {
    setOpened(prev => openedWith(prev, activeSession))
  }, [activeSession])

  // A session this client picked (a tap in the list, or the one it asked
  // for arriving) is there to be looked at; and on a phone the "+ new
  // session" button lives in the drawer, which would hide the new terminal
  // while xterm needs it visible to measure its font.
  useEffect(() => {
    if (picked > 0) applyPanelAction('select-session')
  }, [picked, applyPanelAction])

  // Remember the active session so the next page load reopens it.
  useEffect(() => {
    if (activeSession !== null) storageSet(LAST_SESSION_KEY, String(activeSession))
  }, [activeSession])

  // Every connection introduces this page to the server, which answers
  // with server:hello (handled below). Re-sent on reconnect because the
  // server may have been rebuilt or restarted in between.
  useEffect(() => {
    if (status !== 'connected') return
    send({ type: 'client:hello', build: readPageBuild() })
  }, [status, send])

  // Route incoming messages into local state through the pure reducers.
  useEffect(() => {
    return onMessage((msg) => {
      if (msg.type === 'server:hello') {
        const next = versionNotice(readPageBuild(), msg, import.meta.env.PROD)
        setNotice(next && next.text === dismissedNotice.current ? null : next)
        return
      }
      if (msg.type === 'session:ownership') {
        const next: Record<number, number> = {}
        for (const entry of msg.ownership) next[entry.windowId] = entry.clients
        setOwnership(next)
        return
      }
      // Errors the file panel (files:*) and the terminals (terminal:*, shown
      // as the exited overlay) do not own go to the toast so a failed
      // session op isn't silent. The reducer sees every error too: a
      // failed create must clear the wait for it.
      if (msg.type === 'error') {
        if (!msg.request.startsWith('files:') && !msg.request.startsWith('terminal:')) {
          setToast(failureText(msg))
        }
      } else if (!msg.type.startsWith('session:')) {
        return
      }
      dispatchSessions({
        type: 'message',
        msg,
        savedRaw: msg.type === 'session:list' ? storageGet(LAST_SESSION_KEY) : null,
      })
    })
  }, [onMessage])

  // The toolbar and the Composer act on the active terminal through the
  // registry; neither knows about sessions or the socket.
  useEffect(() => {
    terminalRegistry.setActive(activeSession)
  }, [activeSession])
  const submitText = useCallback((text: string) => terminalRegistry.active()?.submit(text), [])

  // Sticky Ctrl/Alt from the toolbar. Armed here, applied by the active
  // terminal to its next input, then cleared.
  const [modifiers, setModifiers] = useState<Modifiers>(NO_MODIFIERS)
  const toggleModifier = useCallback((which: 'ctrl' | 'alt') => {
    setModifiers(prev => ({ ...prev, [which]: !prev[which] }))
  }, [])
  const clearModifiers = useCallback(() => setModifiers(NO_MODIFIERS), [])

  const selectSession = useCallback((id: number) => {
    dispatchSessions({ type: 'select', id })
  }, [])

  // The reducer notes the wait so only this device switches to the session
  // that arrives.
  const createSession = useCallback(() => {
    dispatchSessions({ type: 'create' })
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
    applyPanelAction('open-file')
  }, [applyPanelAction])

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
    if (action === 'open') applyPanelAction('open-sidebar')
    if (action === 'close') applyPanelAction('close-sidebar')
  }

  const activeSessionData = sessions.find(s => s.id === activeSession)
  const draftKey = activeSession !== null ? draftKeyFor(activeSession) : null

  return (
    <SocketProvider value={socket}>
      <div
        style={{ display: 'flex', height: '100%', width: '100%' }}
        onTouchStart={isMobile ? handleTouchStart : undefined}
        onTouchEnd={isMobile ? handleTouchEnd : undefined}
      >
        <Toast message={toast} onDismiss={dismissToast} />

        {/* Sidebar overlay on mobile */}
        {sidebarOpen && isMobile && (
          <button
            data-testid="sidebar-backdrop"
            aria-label="Close sidebar"
            onClick={() => applyPanelAction('close-sidebar')}
            style={{
              position: 'fixed',
              inset: 0,
              background: 'rgba(0,0,0,0.75)',
              // Same layer as the drawer; the drawer is rendered after it.
              zIndex: 'var(--z-drawer)',
              width: '100%',
              height: '100%',
              border: 'none',
              padding: 0,
              cursor: 'default',
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
          onClose={() => applyPanelAction('close-sidebar')}
          isOpen={sidebarOpen}
          isMobile={isMobile}
          ownership={ownership}
          fontSize={fontSize}
          onFontSizeChange={setFontSize}
        />

        <div data-main-column style={{
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          minWidth: 0,
        }}>
          {/* In the flow above the top bar, so it never covers a control. */}
          <VersionBanner
            notice={notice}
            onReload={() => window.location.reload()}
            onDismiss={() => {
              dismissedNotice.current = notice?.text ?? null
              setNotice(null)
            }}
          />
          <TopBar
            isMobile={isMobile}
            sidebarOpen={sidebarOpen}
            onToggleSidebar={() => applyPanelAction('toggle-sidebar')}
            activeSessionData={activeSessionData}
            mobileView={mobileView}
            onSetMobileView={(view) => applyPanelAction(view === 'files' ? 'show-files' : 'show-terminal')}
            filePanelOpen={filePanelOpen}
            onToggleFilePanel={() => applyPanelAction('toggle-files')}
            toolbarVisible={toolbarVisible}
            onToggleToolbar={toggleToolbar}
          />

          {/* Main content area */}
          <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
            {/* Terminal */}
            <div data-testid="terminal-area" style={{
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
                    touch={IS_TOUCH}
                    isActive={session.id === activeSession}
                    fontSize={fontSize}
                    modifiers={modifiers}
                    onModifiersUsed={clearModifiers}
                  />
                </div>
              ))}
            </div>

            {/* File panel: mounted once so its tree, expansion and any edit in progress survive toggles */}
            <FilePanel
              open={isMobile ? mobileView === 'files' : filePanelOpen}
              openFile={openFile}
              onOpenFile={handleOpenFile}
              onCloseFile={() => setOpenFile(null)}
              onClosePanel={() => applyPanelAction('toggle-files')}
              isMobile={isMobile}
              width={filePanelWidth}
              onResize={setFilePanelWidth}
              cwd={activeSessionData?.cwd ?? ''}
            />
          </div>

          {/* Mobile input bar: see Composer.tsx for why typing goes here. */}
          {isMobile && mobileView === 'terminal' && (
            <Composer
              key={draftKey ?? 'no-session'}
              onSubmit={submitText}
              draftKey={draftKey}
            />
          )}

          {/* Key toolbar: always on touch layouts, opt-in on desktop (TopBar toggle). */}
          {toolbarVisible && (
            <KeyToolbar modifiers={modifiers} onToggleModifier={toggleModifier} isMobile={isMobile} />
          )}
        </div>
      </div>
    </SocketProvider>
  )
}
