// The React side of a terminal: creates the xterm and its addons in the
// DOM the component rendered, hands them to a TerminalController, and
// routes browser events (resize, scroll, focus, wheel, keys) to it. The
// controller's attach state comes back as component state so the overlays
// render from it.

import { useCallback, useEffect, useRef, useState } from 'react'
import type { RefObject } from 'react'
import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { ClipboardAddon } from '@xterm/addon-clipboard'
import { WebglAddon } from '@xterm/addon-webgl'
import { WebLinksAddon } from '@xterm/addon-web-links'
import '@xterm/xterm/css/xterm.css'
import { useSocketContext } from '../SocketContext'
import { canFit } from '../terminalSize'
import { applyModifiers, type Modifiers } from '../keys'
import { paletteFromTheme, type Palette } from '../ansi'
import { monoFont, terminalTheme } from '../theme'
import { URL_RE, cleanUrl } from '../urls'
import { TerminalController, type AttachState } from './TerminalController'
import { createHistoryPane } from './historyPane'
import { bottomInset, composerFocused } from './bottomInset'
import { screenLinesAboveCursor } from './screenRows'

// onSelectionChange fires continuously during a drag; copy once it settles.
const COPY_ON_SELECT_MS = 120

export interface UseTerminalOptions {
  windowId: number
  touch: boolean
  isActive: boolean
  fontSize: number
  modifiers: Modifiers
  onModifiersUsed?: () => void
  scrollRef: RefObject<HTMLDivElement | null>
  historyRef: RefObject<HTMLDivElement | null>
  containerRef: RefObject<HTMLDivElement | null>
  /** Where the xterm opens: the container's padding-free inside, so the fit measures the room it has. */
  hostRef: RefObject<HTMLDivElement | null>
}

export interface UseTerminalResult {
  /** Null until the mount effect has created it. */
  term: XTerm | null
  state: AttachState
  /** This terminal has held a pty before, so a lost socket is a reconnect. */
  wasAttached: boolean
  /** Ask for the pty back after a takeover or an exit. */
  reattach: () => void
  /** Send input with the toolbar's sticky modifiers applied. */
  sendInput: (data: string) => void
  /** The scrollback holds a prompt line the reader can jump back to. */
  promptAvailable: boolean
  /** Scroll to the latest prompt line; again for the one before it. */
  jumpToPrompt: () => void
}

interface Live {
  term: XTerm
  controller: TerminalController
}

/** Open a URL from the live screen in a new tab that cannot reach this one. */
function openLink(_event: MouseEvent, uri: string): void {
  window.open(cleanUrl(uri), '_blank', 'noopener')
}

/** Focus the Composer on touch (typing goes there), the xterm otherwise. */
export function focusInput(term: XTerm, touch: boolean): void {
  if (touch) {
    const ta = document.querySelector<HTMLTextAreaElement>('[data-composer] textarea')
    if (ta) {
      ta.focus()
      return
    }
  }
  term.focus()
}

export function useTerminal({
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
}: UseTerminalOptions): UseTerminalResult {
  const { send, onMessage, status } = useSocketContext()
  const [live, setLive] = useState<Live | null>(null)
  const [state, setState] = useState<AttachState>('idle')
  const [promptAvailable, setPromptAvailable] = useState(false)
  // Read by listeners installed once, so they see the current values
  // without re-subscribing.
  const fontSizeRef = useRef(fontSize)
  fontSizeRef.current = fontSize
  const modifiersRef = useRef(modifiers)
  modifiersRef.current = modifiers
  const onModifiersUsedRef = useRef(onModifiersUsed)
  onModifiersUsedRef.current = onModifiersUsed

  const sendInput = useCallback((data: string) => {
    const mods = modifiersRef.current
    let bytes = data
    if (mods.ctrl || mods.alt) {
      onModifiersUsedRef.current?.()
      bytes = applyModifiers(data, mods)
    }
    send({ type: 'terminal:input', windowId, data: bytes })
  }, [send, windowId])

  // Mount: the xterm, its addons and the controller, and every listener.
  useEffect(() => {
    const container = containerRef.current
    const host = hostRef.current
    const scrollEl = scrollRef.current
    const historyEl = historyRef.current
    if (!container || !host || !scrollEl || !historyEl) return

    const theme = terminalTheme()
    const palette: Palette = paletteFromTheme(theme)
    const term = new XTerm({
      theme,
      fontFamily: monoFont(),
      fontSize: fontSizeRef.current,
      lineHeight: 1.4,
      cursorStyle: 'bar',
      cursorBlink: true,
      cursorInactiveStyle: 'none',
      scrollback: 0,
      allowTransparency: true,
      convertEol: true,
    })
    const fitAddon = new FitAddon()
    term.loadAddon(fitAddon)
    term.loadAddon(new ClipboardAddon())
    // The fit addon sizes the pty from the host's width, so the host is
    // the container's inside: with padding on the host itself the addon
    // would read the padded width and the screen would run past it.
    term.open(host)
    // Click/tap a URL on the live screen to open it (all platforms), with
    // the pattern history links use so both agree on where a URL ends.
    term.loadAddon(new WebLinksAddon(openLink, { urlRegex: URL_RE }))
    // WebGL on desktop only. The DOM renderer leaves text in the DOM so
    // native long-press selection works on phones. WebGL paints to a canvas
    // where the browser can't select text at all.
    let webgl: WebglAddon | null = null
    if (!touch) {
      try {
        webgl = new WebglAddon()
        webgl.onContextLoss(() => {
          webgl?.dispose()
          webgl = null
        })
        term.loadAddon(webgl)
      } catch {
        webgl = null
      }
    }

    const controller = new TerminalController({
      term,
      windowId,
      send,
      fit: () => {
        if (!canFit(container.clientWidth, container.clientHeight)) return false
        fitAddon.fit()
        return true
      },
      scroll: scrollEl,
      history: createHistoryPane(historyEl, palette),
      screen: container,
      inset: touch ? () => (composerFocused() ? bottomInset(term, scrollEl) : 0) : undefined,
      screenLines: () => screenLinesAboveCursor(term, scrollEl),
      onStateChange: setState,
      onPromptAvailable: setPromptAvailable,
    })
    const unsubscribe = onMessage((msg) => controller.handle(msg))

    const observer = new ResizeObserver(() => controller.scheduleFit())
    observer.observe(container)

    // On phones the keyboard shrinks the scroll viewport but must not shrink
    // the pty: the container keeps the tallest height seen, so xterm never
    // refits, Claude Code never repaints, and the server never resends history.
    let fullH = 0
    let lastW = 0
    const scrollObserver = new ResizeObserver(() => {
      if (touch) {
        const w = scrollEl.clientWidth
        const h = scrollEl.clientHeight
        if (w !== lastW) {
          lastW = w
          fullH = 0
        }
        if (h > fullH) {
          fullH = h
          container.style.setProperty('--xterm-full-h', `${fullH}px`)
        }
      }
      controller.maybeScrollToBottom()
    })
    scrollObserver.observe(scrollEl)

    const handleScroll = () => controller.handleScroll()
    scrollEl.addEventListener('scroll', handleScroll, { passive: true })
    // Capture, so the gesture is seen before the container's wheel handler
    // below stops it and before the scroll event it causes.
    const onGesture = () => controller.onScrollGesture()
    scrollEl.addEventListener('wheel', onGesture, { capture: true, passive: true })
    scrollEl.addEventListener('touchstart', onGesture, { capture: true, passive: true })
    scrollEl.addEventListener('keydown', onGesture, { capture: true })
    const onFocusChange = () => controller.onFocusChange()
    if (touch) {
      document.addEventListener('focusin', onFocusChange)
      document.addEventListener('focusout', onFocusChange)
    }

    // xterm.js doesn't support the kitty keyboard protocol, so Shift+Enter
    // sends plain \r like Enter. Claude Code's input widget uses CSI u
    // encoding (ESC[13;2u) to tell them apart. Intercept here so multiline
    // input works through Foray the same way it does in a local terminal.
    term.attachCustomKeyEventHandler((e) => {
      if (e.type === 'keydown' && e.key === 'Enter' && e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) {
        send({ type: 'terminal:input', windowId, data: '\x1b[13;2u' })
        return false
      }
      return true
    })
    const dataSub = term.onData(sendInput)

    // Copy on select: a drag selection lands on the system clipboard without
    // a further keystroke. OSC 52 (ClipboardAddon) and Cmd/Ctrl+C keep
    // working as before. Not on touch: select mode is the way to copy there,
    // and a long press must not overwrite the clipboard on its own.
    let copyTimer: ReturnType<typeof setTimeout> | null = null
    const selectionSub = touch
      ? null
      : term.onSelectionChange(() => {
          if (copyTimer) clearTimeout(copyTimer)
          copyTimer = setTimeout(() => {
            copyTimer = null
            const text = term.getSelection()
            if (!text || typeof navigator.clipboard?.writeText !== 'function') return
            navigator.clipboard.writeText(text).catch(() => {})
          }, COPY_ON_SELECT_MS)
        })

    // Wheel over the xterm canvas must scroll the outer container instead
    // of being consumed by xterm (which would convert it to arrow keys on
    // the alternate screen). Capture + stopImmediatePropagation prevents
    // the event from reaching any handler registered later on this element
    // or any descendant, so xterm never sees it.
    const handleWheel = (e: WheelEvent) => {
      e.preventDefault()
      e.stopImmediatePropagation()
      let dy = e.deltaY
      if (e.deltaMode === 1) {
        const screen = term.element?.querySelector<HTMLElement>('.xterm-screen')
        const h = screen?.clientHeight || container.clientHeight
        dy *= h / Math.max(term.rows, 1)
      }
      scrollEl.scrollTop += dy
    }
    container.addEventListener('wheel', handleWheel, { capture: true, passive: false })

    setLive({ term, controller })

    return () => {
      setLive(null)
      setState('idle')
      setPromptAvailable(false)
      webgl?.dispose()
      webgl = null
      if (copyTimer) clearTimeout(copyTimer)
      scrollEl.removeEventListener('scroll', handleScroll)
      scrollEl.removeEventListener('wheel', onGesture, { capture: true })
      scrollEl.removeEventListener('touchstart', onGesture, { capture: true })
      scrollEl.removeEventListener('keydown', onGesture, { capture: true })
      container.removeEventListener('wheel', handleWheel, { capture: true })
      document.removeEventListener('focusin', onFocusChange)
      document.removeEventListener('focusout', onFocusChange)
      selectionSub?.dispose()
      dataSub.dispose()
      unsubscribe()
      observer.disconnect()
      scrollObserver.disconnect()
      controller.dispose()
      term.dispose()
    }
  }, [windowId, send, onMessage, sendInput, touch, containerRef, hostRef, scrollRef, historyRef])

  // A new socket means the old pty is gone; the controller asks again.
  useEffect(() => {
    live?.controller.onStatus(status)
  }, [status, live])

  // Only the active terminal holds a pty. The xterm stays mounted with its
  // screen either way, so switching back shows the last state at once.
  useEffect(() => {
    if (!live) return
    if (isActive) live.controller.attach()
    else live.controller.detach()
  }, [isActive, live])

  useEffect(() => {
    if (isActive && live) focusInput(live.term, touch)
  }, [isActive, live, touch])

  useEffect(() => {
    if (!live || live.term.options.fontSize === fontSize) return
    live.term.options.fontSize = fontSize
    live.controller.scheduleFit()
  }, [fontSize, live])

  const reattach = useCallback(() => live?.controller.attach(), [live])
  const jumpToPrompt = useCallback(() => {
    live?.controller.jumpToPrompt()
  }, [live])

  return {
    term: live?.term ?? null,
    state,
    wasAttached: live?.controller.wasAttached ?? false,
    reattach,
    sendInput,
    promptAvailable,
    jumpToPrompt,
  }
}
