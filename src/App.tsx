import { useState, useCallback, useEffect, useReducer, useRef } from 'react'
import type { TouchEvent as ReactTouchEvent } from 'react'
import { Sidebar } from './Sidebar'
import { Terminal } from './Terminal'
import { KeyToolbar } from './KeyToolbar'
import { Composer } from './Composer'
import { FilePanel } from './FilePanel'
import { useSocket } from './hooks/useSocket'
import { SocketProvider } from './SocketContext'
import { useAppHeight } from './hooks/useAppHeight'
import { openedWith, pendingCreateAfter, reduceSessions, type SessionsState } from './sessionState'
import { NO_MODIFIERS, shortcutAction, type Modifiers } from './keys'
import {
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
import { TopBar } from './TopBar'
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

const NO_SESSIONS: SessionsState = { sessions: [], active: null }

export function App() {
  const socket = useSocket()
  const { onMessage, send, status } = socket

  const [{ sessions, active: activeSession }, dispatchSessions] = useReducer(reduceSessions, NO_SESSIONS)
  // Set when this client asks for a session, so that only this device
  // switches to the one that arrives (see pendingCreateAfter).
  const pendingCreate = useRef(false)
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
  const [filePanelWidth, setFilePanelWidth] = useState(320)

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
      // Errors the file panel doesn't own (it filters on files:*) have no UI
      // yet; log them so a failed session op isn't silent.
      if (msg.type === 'error' && !msg.request.startsWith('files:')) {
        console.error(`[nest] ${msg.request} failed: ${msg.message}`)
        return
      }
      if (msg.type === 'session:ownership') {
        const next: Record<number, number> = {}
        for (const entry of msg.ownership) next[entry.windowId] = entry.clients
        setOwnership(next)
        return
      }
      const own = pendingCreate.current && msg.type === 'session:created'
      pendingCreate.current = pendingCreateAfter(pendingCreate.current, msg)
      if (!msg.type.startsWith('session:')) return
      dispatchSessions({
        type: 'message',
        msg,
        own,
        savedRaw: msg.type === 'session:list' ? storageGet(LAST_SESSION_KEY) : null,
      })
      // You created it to look at it; and on a phone the "+ new session"
      // button lives in the drawer, which would hide the new terminal
      // while xterm needs it visible to measure its font.
      if (own) applyPanelAction('select-session')
    })
  }, [onMessage, applyPanelAction])

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
    dispatchSessions({ type: 'select', id })
    applyPanelAction('select-session')
  }, [applyPanelAction])

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
    applyPanelAction('open-file')
  }, [applyPanelAction])

  const handleCloseFile = useCallback(() => {
    setOpenFile(null)
    applyPanelAction('close-file')
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
        <VersionBanner
          notice={notice}
          onReload={() => window.location.reload()}
          onDismiss={() => {
            dismissedNotice.current = notice?.text ?? null
            setNotice(null)
          }}
        />

        {/* Sidebar overlay on mobile */}
        {sidebarOpen && isMobile && (
          <div
            data-testid="sidebar-backdrop"
            onClick={() => applyPanelAction('close-sidebar')}
            style={{
              position: 'fixed',
              inset: 0,
              background: 'rgba(0,0,0,0.75)',
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
              />
            )}
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
            <KeyToolbar
              onSend={sendKeys}
              onPaste={pasteText}
              onUpload={uploadFiles}
              modifiers={modifiers}
              onToggleModifier={toggleModifier}
              isMobile={isMobile}
            />
          )}
        </div>
      </div>
    </SocketProvider>
  )
}
