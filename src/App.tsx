import { useState, useCallback, useEffect, useRef } from 'react'
import type { TouchEvent as ReactTouchEvent } from 'react'
import { Sidebar } from './Sidebar'
import { Terminal } from './Terminal'
import { KeyToolbar } from './KeyToolbar'
import { Composer } from './Composer'
import { FilePanel } from './FilePanel'
import { useSocket } from './hooks/useSocket'
import { useAppHeight } from './hooks/useAppHeight'
import { applySessionMessage, openedWith, type Session } from './sessionState'
import { NO_MODIFIERS, shortcutAction, type Modifiers } from './keys'
import {
  FONT_SIZE_KEY,
  KEY_TOOLBAR_KEY,
  MOBILE_MEDIA_QUERY,
  clampFontSize,
  defaultFontSize,
  isMobileViewport,
  readFontSize,
  readToolbarVisible,
  resolvePanels,
  swipeAction,
  type PanelAction,
  type Point,
} from './mobile'
import { TopBar } from './TopBar'
import { VersionBanner } from './VersionBanner'
import { readPageBuild, versionNotice, type VersionNotice } from './version'

export type MobileView = 'terminal' | 'files'

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

const LAST_SESSION_KEY = 'nest:lastSession'
const DRAFT_KEY_PREFIX = 'nest:draft:'

export function App() {
  const socket = useSocket()
  const { onMessage, send, status } = socket

  const [sessions, setSessions] = useState<Session[]>([])
  const [activeSession, setActiveSessionRaw] = useState<number | null>(null)

  const setActiveSession = useCallback((idOrFn: number | null | ((prev: number | null) => number | null)) => {
    setActiveSessionRaw(prev => {
      const next = typeof idOrFn === 'function' ? idOrFn(prev) : idOrFn
      if (next !== null) storageSet(LAST_SESSION_KEY, String(next))
      return next
    })
  }, [])
  // Sessions whose terminal has been mounted (see openedWith).
  const [opened, setOpened] = useState<number[]>([])
  // windowId -> number of attached clients, from session:ownership broadcasts.
  const [ownership, setOwnership] = useState<Record<number, number>>({})
  // Version drift reported by the server (src/version.ts). Dismissing hides
  // a given notice text until the server reports something different.
  const [notice, setNotice] = useState<VersionNotice | null>(null)
  const dismissedNotice = useRef<string | null>(null)
  // Desktop starts with the sidebar in view; a phone starts on the terminal.
  const [sidebarOpen, setSidebarOpen] = useState(() => !detectMobile())
  const [filePanelOpen, setFilePanelOpen] = useState(false)
  // The stored key-toolbar choice; readToolbarVisible turns it into a
  // decision (touch layouts always show it).
  const [toolbarChoice, setToolbarChoice] = useState(() => storageGet(KEY_TOOLBAR_KEY))
  const [mobileView, setMobileView] = useState<MobileView>('terminal')
  const [openFile, setOpenFile] = useState<string | null>(null)
  const [filePanelWidth, setFilePanelWidth] = useState(320)

  const isMobile = useIsMobile()
  // The session:* message handler is installed once (deps: [onMessage]); a ref
  // keeps the current mobile state visible to it without re-subscribing.
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

  // Side panels go through resolvePanels so a tablet never shows both at
  // once (AUDIT #6). A ref keeps the current state visible to the keyboard
  // listener, which is installed once.
  const panelsRef = useRef({ sidebarOpen, filePanelOpen })
  panelsRef.current = { sidebarOpen, filePanelOpen }
  const applyPanelAction = useCallback((action: PanelAction) => {
    const next = resolvePanels(panelsRef.current, action, window.innerWidth)
    setSidebarOpen(next.sidebarOpen)
    setFilePanelOpen(next.filePanelOpen)
  }, [])

  // Keyboard shortcuts for the chrome (AUDIT #9). Captured on window so they
  // win over xterm, which otherwise swallows every key while focused.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const action = shortcutAction(e)
      if (!action) return
      e.preventDefault()
      e.stopPropagation()
      if (isMobileRef.current && action === 'toggle-files') {
        setMobileView(v => (v === 'files' ? 'terminal' : 'files'))
        return
      }
      applyPanelAction(action)
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [applyPanelAction])

  // Mount a terminal for whichever session becomes active.
  useEffect(() => {
    setOpened(prev => openedWith(prev, activeSession))
  }, [activeSession])

  // Every connection introduces this page to the server, which answers
  // with server:hello (handled below). Re-sent on reconnect because the
  // server may have been rebuilt or restarted in between.
  useEffect(() => {
    if (status !== 'connected') return
    send({ type: 'client:hello', build: readPageBuild() })
  }, [status, send])

  // Route incoming session:* messages into local state via the pure
  // applySessionMessage reducer.
  useEffect(() => {
    return onMessage((msg) => {
      if (msg.type === 'server:hello') {
        const next = versionNotice(readPageBuild(), msg, import.meta.env.PROD)
        setNotice(next && next.text === dismissedNotice.current ? null : next)
        return
      }
      if (msg.type === 'session:list') {
        setSessions(msg.windows)
        setActiveSession(prev => {
          if (prev !== null && msg.windows.some(w => w.id === prev)) return prev
          // First list on this page load: reopen whichever session this device
          // was last looking at, if it still exists.
          const savedRaw = storageGet(LAST_SESSION_KEY)
          const saved = savedRaw !== null ? Number(savedRaw) : NaN
          if (Number.isInteger(saved) && msg.windows.some(w => w.id === saved)) return saved
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
        // The "+ new session" button lives in the drawer; on a phone, close it
        // so the new terminal isn't hidden behind it.
        if (isMobileRef.current) setSidebarOpen(false)
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
      applyPanelAction('open-files')
    }
  }, [isMobile, applyPanelAction])

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
          onClick={() => setSidebarOpen(false)}
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
        onClose={() => setSidebarOpen(false)}
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
          onSetMobileView={setMobileView}
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
          <Composer
            onSubmit={submitText}
            draftKey={activeSession !== null ? `${DRAFT_KEY_PREFIX}${activeSession}` : null}
          />
        )}

        {/* Key toolbar — CSS container query hides it when the keyboard
            shrinks the layout on mobile (see styles.css). */}
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
  )
}
