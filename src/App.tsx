import { useState, useCallback, useEffect, useReducer, useRef } from 'react'
import type { TouchEvent as ReactTouchEvent } from 'react'
import { Settings } from './Settings'
import { Sidebar } from './Sidebar'
import { Terminal } from './Terminal'
import { KeyToolbar } from './KeyToolbar'
import { Composer } from './Composer'
import { FilePanel } from './files/FilePanel'
import { useSocket } from './hooks/useSocket'
import { SocketProvider } from './SocketContext'
import { useAppHeight } from './hooks/useAppHeight'
import { NO_SESSIONS, cycleSession, displayName, openedWith, reduceSessions } from './sessionState'
import {
  LEADER_CONFIRM_MS,
  LEADER_HINT,
  LEADER_HINT_DELAY_MS,
  LEADER_TIMEOUT_MS,
  NO_MODIFIERS,
  confirmCloseHint,
  isModifierKey,
  leaderAction,
  shortcutAction,
  type LeaderAction,
  type LeaderMode,
  type Modifiers,
  type ShortcutAction,
} from './keys'
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
import {
  SYNC_COMMAND,
  holdsSyncSession,
  planSync,
  readPageBuild,
  versionNotice,
  type VersionNotice,
} from './version'
import type { PastSession } from './shared/protocol'

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
  // Where the server runs from, from server:hello: the directory the
  // banner's "sync now" deploys in. Null until the first hello, and on a
  // server too old to send it (see ServerHelloMessage.serverRoot).
  const serverRoot = useRef<string | null>(null)
  // "sync now" is waiting for the session it asked for. Only the create
  // this page sent may run the deploy: session:created is broadcast to
  // every client, and another device's new session is not ours to type in.
  const syncPending = useRef(false)
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
  // Past agent sessions from disk; null until the first reply arrives.
  const [pastSessions, setPastSessions] = useState<PastSession[] | null>(null)
  // The leader key: Cmd+K arms it, the next keystroke spends it.
  const [leaderMode, setLeaderMode] = useState<LeaderMode>(null)
  const [leaderHint, setLeaderHint] = useState<string | null>(null)
  // The session the leader's "r" wants renamed; the Sidebar clears it.
  const [renameRequest, setRenameRequest] = useState<number | null>(null)
  const clearRenameRequest = useCallback(() => setRenameRequest(null), [])
  // The leader's "i" opens this; upload runs through the active terminal.
  const insertInput = useRef<HTMLInputElement>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const openSettings = useCallback(() => setSettingsOpen(true), [])
  const closeSettings = useCallback(() => setSettingsOpen(false), [])

  const isMobile = useIsMobile()
  // Listeners installed once (the socket handler, the keyboard shortcuts)
  // read the current layout through this ref instead of re-subscribing.
  const isMobileRef = useRef(isMobile)
  isMobileRef.current = isMobile
  // Same reason: the shortcut handler needs the current session list
  // without being torn down and rebuilt on every poll.
  const sessionsRef = useRef(sessions)
  sessionsRef.current = sessions
  const activeSessionRef = useRef(activeSession)
  activeSessionRef.current = activeSession
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
        serverRoot.current = msg.serverRoot ?? null
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
      if (msg.type === 'sessions:past') {
        setPastSessions(msg.sessions)
        return
      }
      // The server sends a list on connect and whenever it changes (a
      // session appearing, a shell becoming an agent); each is a moment
      // the past list and its live chips may have changed too.
      if (msg.type === 'session:list') send({ type: 'sessions:past' })
      // Errors the file panel (files:*) and the terminals (terminal:*, shown
      // as the exited overlay) do not own go to the toast so a failed
      // session op isn't silent. The reducer sees every error too: a
      // failed create must clear the wait for it.
      if (msg.type === 'error') {
        // The session "sync now" asked for never arrived; nothing is
        // waiting for it any more.
        if (msg.request === 'session:create') syncPending.current = false
        if (!msg.request.startsWith('files:') && !msg.request.startsWith('terminal:')) {
          setToast(failureText(msg))
        }
      } else if (!msg.type.startsWith('session:')) {
        return
      }
      if (msg.type === 'session:created' && syncPending.current) {
        syncPending.current = false
        if (holdsSyncSession(msg.window)) {
          // Not sent straight away: the terminal for a session this page
          // just created has not attached yet, and input before that
          // reaches no pty (terminalRegistry.runWhenAttached).
          terminalRegistry.runWhenAttached(msg.window.id, SYNC_COMMAND)
        } else {
          // Another client's session arrived in the gap and took the name
          // (or just took the wait); ours is a spare shell, and nothing
          // has been typed into either.
          setToast('Another session arrived first, so no deploy was started. Reload to try again.')
        }
      }
      dispatchSessions({
        type: 'message',
        msg,
        savedRaw: msg.type === 'session:list' ? storageGet(LAST_SESSION_KEY) : null,
      })
    })
  }, [onMessage, send])

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

  /**
   * The version banner's "sync now": build and restart the server from a
   * session on the box, where the user can watch it and answer anything it
   * asks. The deploy restarts Foray under pm2, but tmux is a systemd unit
   * of its own, so the session running the build outlives that; this page
   * loses its socket for a moment and reconnects to the new server.
   *
   * The session is the lock (planSync): one already called "deploy" means
   * a deploy is running, so this only brings it into view.
   */
  const syncServer = useCallback(() => {
    const step = planSync(sessionsRef.current, serverRoot.current)
    if (step.kind === 'focus') {
      // Show the deploy that holds the lock rather than starting a second
      // one. It may be a session an earlier deploy finished in and left
      // behind, which is why the toast says what to do about that.
      selectSession(step.windowId)
      setToast('A deploy session is already open. If its build has finished, close it and sync again.')
      return
    }
    syncPending.current = true
    dispatchSessions({ type: 'create' })
    send({ type: 'session:create', name: step.name, ...(step.cwd === null ? {} : { cwd: step.cwd }) })
  }, [selectSession, send])

  // A revive arrives as an ordinary session:created, so the same wait
  // makes only this device switch to it.
  const reviveSession = useCallback((agent: string, sessionId: string) => {
    dispatchSessions({ type: 'create' })
    send({ type: 'session:revive', agent, sessionId })
  }, [send])

  const renameSession = useCallback((id: number, name: string) => {
    send({ type: 'session:rename', windowId: id, name })
  }, [send])

  const runShortcut = useCallback((action: ShortcutAction) => {
    switch (action) {
      case 'toggle-sidebar':
      case 'toggle-files':
        applyPanelAction(action)
        break
      case 'next-session':
      case 'prev-session': {
        const id = cycleSession(
          sessionsRef.current,
          activeSessionRef.current,
          action === 'next-session' ? 1 : -1,
        )
        if (id !== null) selectSession(id)
        break
      }
      case 'arm-leader':
        setLeaderMode('armed')
        break
    }
  }, [applyPanelAction, selectSession])

  const runLeaderAction = useCallback((action: LeaderAction | null) => {
    const active = activeSessionRef.current
    switch (action) {
      case 'new-session':
        createSession()
        break
      case 'close-session':
        // Not reached: the key listener arms a confirmation instead.
        break
      case 'rename-session':
        // The rename editor lives in the sidebar, so bring it into view.
        if (active === null) break
        applyPanelAction('open-sidebar')
        setRenameRequest(active)
        break
      case 'insert-file':
        // Must run inside the keystroke: browsers refuse a file dialog
        // that is not opened from a user gesture.
        insertInput.current?.click()
        break
      default:
        // An unbound key. The leader still ate it; nothing else to do.
        break
    }
  }, [applyPanelAction, createSession])

  // Keyboard shortcuts for the chrome. Captured on window so they win over
  // xterm, which otherwise swallows every key while focused.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (leaderMode !== null) {
        // Holding a modifier is not yet a choice; wait for the real key.
        if (isModifierKey(e.key)) return
        e.preventDefault()
        e.stopPropagation()
        const action = leaderAction(e.key)
        if (leaderMode === 'confirm-close') {
          setLeaderMode(null)
          // Only "x" again goes through; every other key is a cancel.
          const active = activeSessionRef.current
          if (action === 'close-session' && active !== null) killSession(active)
          return
        }
        // A kill cannot be undone, so it costs a second press.
        if (action === 'close-session' && activeSessionRef.current !== null) {
          setLeaderMode('confirm-close')
          return
        }
        setLeaderMode(null)
        runLeaderAction(action)
        return
      }
      const action = shortcutAction(e)
      if (!action) return
      e.preventDefault()
      e.stopPropagation()
      runShortcut(action)
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [leaderMode, killSession, runLeaderAction, runShortcut])

  // While the leader is armed: show the hint after a beat, and give up
  // after the timeout so a stray Cmd+K does not stay live. The kill
  // confirmation skips the delay — a destructive prompt has to be on
  // screen the instant it is armed — and gets longer to be answered.
  useEffect(() => {
    if (leaderMode === null) {
      setLeaderHint(null)
      return
    }
    if (leaderMode === 'confirm-close') {
      const session = sessionsRef.current.find(s => s.id === activeSessionRef.current)
      setLeaderHint(confirmCloseHint(session ? displayName(session) : 'this session'))
      const disarm = setTimeout(() => setLeaderMode(null), LEADER_CONFIRM_MS)
      return () => clearTimeout(disarm)
    }
    const show = setTimeout(() => setLeaderHint(LEADER_HINT), LEADER_HINT_DELAY_MS)
    const disarm = setTimeout(() => setLeaderMode(null), LEADER_TIMEOUT_MS)
    return () => {
      clearTimeout(show)
      clearTimeout(disarm)
    }
  }, [leaderMode])

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
        <Toast
          message={leaderHint ?? toast}
          onDismiss={dismissToast}
          tone={leaderHint === null ? 'error' : 'hint'}
        />

        {/* The leader's "i" picker. Upload goes through the active
            terminal, the same path the toolbar's photo key uses. */}
        <input
          ref={insertInput}
          type="file"
          accept="image/png,image/jpeg,image/gif,image/webp"
          multiple
          onChange={e => {
            const files = Array.from(e.target.files ?? [])
            // Reset so picking the same file twice still fires change.
            e.target.value = ''
            if (files.length > 0) terminalRegistry.active()?.upload(files)
          }}
          style={{ display: 'none' }}
          aria-hidden="true"
          tabIndex={-1}
        />

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
          pastSessions={pastSessions}
          onRevive={reviveSession}
          onClose={() => applyPanelAction('close-sidebar')}
          isOpen={sidebarOpen}
          isMobile={isMobile}
          ownership={ownership}
          renameRequest={renameRequest}
          onRenameRequestHandled={clearRenameRequest}
          onOpenSettings={openSettings}
        />

        <Settings
          open={settingsOpen}
          onClose={closeSettings}
          isMobile={isMobile}
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
            actions={{ reload: () => window.location.reload(), sync: syncServer }}
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
