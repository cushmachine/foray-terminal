// One tmux window on screen: a scrollback pane above a live xterm, in a
// scroll container the user (or the pin) moves. The lifecycle lives in
// terminal/TerminalController.ts, the DOM wiring in terminal/useTerminal.ts,
// and the layers drawn over the screen in terminal/overlays.tsx; this
// component composes them and registers the actions the chrome can ask of
// the active terminal (terminalRegistry.ts).

import { useCallback, useEffect, useRef, useState } from 'react'
import { useSocketContext } from './SocketContext'
import { NO_MODIFIERS, type Modifiers } from './keys'
import { snapshotText, visibleLogicalLines } from './selectMode'
import { terminalRegistry, type TerminalActions } from './terminalRegistry'
import { useTerminal, focusInput } from './terminal/useTerminal'
import { useImageUpload } from './hooks/useImageUpload'
import { ConnectionOverlay, DetachedOverlay, SelectModeOverlay, UploadOverlay } from './terminal/overlays'
import type { Terminal as XTerm } from '@xterm/xterm'

interface TerminalProps {
  windowId: number
  /**
   * Touch device (see IS_TOUCH in mobile.ts; static for the page's life).
   * Drives the mobile-only terminal policy: DOM renderer, fixed pty height,
   * composer-mode scroll inset.
   */
  touch?: boolean
  isActive?: boolean
  fontSize?: number
  modifiers?: Modifiers
  onModifiersUsed?: () => void
}

/**
 * Gap between a submitted text and its Enter. xterm's paste is synchronous,
 * so both would otherwise reach the pane in one read, and a program that
 * groups a burst of input as one paste (Claude Code) would take the Enter
 * as a newline inside the paste instead of as the keypress that sends it.
 */
const SUBMIT_ENTER_DELAY_MS = 40

/** The frozen text for select mode, and where the live view was scrolled when it opened. */
interface Selection {
  text: string
  scrollTop: number
}

/**
 * Test hook: the active terminal's xterm instance and actions as
 * window.__nest, so the visual suite can read the screen buffer (the WebGL
 * renderer paints to a canvas, so the text is not in the DOM) and type
 * into the terminal. Returns the matching unpublish.
 */
function publishTerm(term: XTerm, actions: TerminalActions): () => void {
  const w = window as unknown as { __nest?: { term: XTerm; actions: TerminalActions } }
  w.__nest = { term, actions }
  return () => {
    if (w.__nest?.term === term) delete w.__nest
  }
}

export function Terminal({
  windowId,
  touch = false,
  isActive = false,
  fontSize = 14,
  modifiers = NO_MODIFIERS,
  onModifiersUsed,
}: TerminalProps) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const historyRef = useRef<HTMLDivElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const hostRef = useRef<HTMLDivElement>(null)
  const { send, status } = useSocketContext()
  const { term, state, wasAttached, reattach, sendInput } = useTerminal({
    windowId,
    touch,
    isActive,
    fontSize,
    modifiers,
    onModifiersUsed,
    scrollRef,
    historyRef,
    containerRef,
    hostRef,
  })
  const restoreFocus = useCallback(() => {
    if (term) focusInput(term, touch)
  }, [term, touch])
  const upload = useImageUpload({ windowId, containerRef, onSettled: restoreFocus })
  const [selecting, setSelecting] = useState<Selection | null>(null)
  const submitTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    return () => {
      if (submitTimer.current) clearTimeout(submitTimer.current)
    }
  }, [])

  // Select mode: freeze scrollback plus screen as plain text (selectMode.ts).
  // The toolbar key toggles it; the overlay's Done closes it.
  const toggleSelectMode = useCallback(() => {
    setSelecting((current) => {
      if (current !== null || !term) return null
      const history = Array.from(historyRef.current?.children ?? [], (row) => row.textContent ?? '')
      return {
        text: snapshotText(history, visibleLogicalLines(term)),
        scrollTop: scrollRef.current?.scrollTop ?? 0,
      }
    })
  }, [term])

  // What the toolbar, the Composer and the photo picker can ask of this
  // terminal while it is the active one.
  useEffect(() => {
    if (!term) return
    const actions: TerminalActions = {
      sendKeys: (data) => {
        term.focus()
        sendInput(data)
      },
      paste: (text) => {
        term.focus()
        term.paste(text)
      },
      submit: (text) => {
        if (text) term.paste(text)
        if (submitTimer.current) clearTimeout(submitTimer.current)
        submitTimer.current = setTimeout(() => {
          submitTimer.current = null
          send({ type: 'terminal:input', windowId, data: '\r' })
        }, text ? SUBMIT_ENTER_DELAY_MS : 0)
      },
      upload: (files) => void upload.uploadFiles(files),
      toggleSelectMode,
    }
    const unregister = terminalRegistry.register(windowId, actions)
    const unpublish = isActive ? publishTerm(term, actions) : null
    return () => {
      unregister()
      unpublish?.()
    }
  }, [term, windowId, isActive, send, sendInput, upload.uploadFiles, toggleSelectMode])

  return (
    <div
      data-testid="terminal"
      // Every opened session keeps its terminal mounted (hidden when not
      // active); only the active one answers to the "terminal" test id, so
      // the visual suite's getByTestId('terminal') is unique.
      {...(isActive ? {} : { 'data-testid': 'terminal-inactive' })}
      style={{ position: 'relative', width: '100%', height: '100%', display: 'flex', flexDirection: 'column' }}
      {...upload.dragHandlers}
    >
      <div
        ref={scrollRef}
        data-testid="terminal-scroll"
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: 'auto',
          overscrollBehavior: 'contain',
          WebkitOverflowScrolling: 'touch',
          background: 'var(--bg)',
        }}
      >
        <div
          ref={historyRef}
          style={{
            fontSize,
            lineHeight: 1.4,
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-all',
            // The right padding is adjusted so the text is exactly the pty's
            // columns wide, measured in this font, and lines break where
            // tmux broke them (terminal/historyPane.ts).
            padding: '0 8px',
            color: 'var(--text)',
            userSelect: 'text',
            WebkitUserSelect: 'text',
          }}
        />
        <div
          ref={containerRef}
          data-xterm-screen
          style={{
            width: '100%',
            height: touch ? 'var(--xterm-full-h, 100%)' : '100%',
            padding: 8,
          }}
        >
          <div ref={hostRef} style={{ width: '100%', height: '100%' }} />
        </div>
      </div>
      {selecting !== null && (
        <SelectModeOverlay
          text={selecting.text}
          scrollTop={selecting.scrollTop}
          fontSize={fontSize}
          onDone={() => setSelecting(null)}
          restoreFocus={restoreFocus}
        />
      )}
      <UploadOverlay dragging={upload.dragging} status={upload.status} />
      {(state === 'takenOver' || state === 'exited') && (
        <DetachedOverlay reason={state} onReattach={reattach} />
      )}
      {status !== 'connected' && <ConnectionOverlay reconnecting={wasAttached} />}
    </div>
  )
}
