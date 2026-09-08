import { useCallback, useEffect, useRef, useState } from 'react'
import type { DragEvent as ReactDragEvent } from 'react'
import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { ClipboardAddon } from '@xterm/addon-clipboard'
import { WebglAddon } from '@xterm/addon-webgl'
import { WebLinksAddon } from '@xterm/addon-web-links'
import '@xterm/xterm/css/xterm.css'
import { useSocketContext } from './SocketContext'
import { MAX_HISTORY_LINES } from './shared/protocol'
import { imageFilesFromClipboard, pathToTerminalInput, pickImageFiles, uploadImage } from './imageUpload'
import { canFit, nextResize, type TerminalDims } from './terminalSize'
import { NO_MODIFIERS, applyModifiers, type Modifiers } from './keys'
import { paletteFromTheme, ansiLineToHtml, type Palette } from './ansi'
import { MONO_FONT, THEME } from './theme'
import { joinWrapped } from './links'
import { linkifyRows } from './linkify'
import { snapshotText } from './selectMode'
import { ANCHOR_ROWS, findAnchorRow, type RowAnchor } from './scrollAnchor'

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

const PALETTE: Palette = paletteFromTheme(THEME)

interface UploadStatus {
  kind: 'uploading' | 'error'
  message: string
}

const UPLOAD_ERROR_FLASH_MS = 4000
// onSelectionChange fires continuously during a drag; copy once it settles.
const COPY_ON_SELECT_MS = 120
const COPIED_FLASH_MS = 1500
const SEPARATOR = /^[\s─━═╌┄]+$/
const PROMPT = /^\s*❯/

/**
 * Test hook: the active terminal's xterm instance as window.__nest.term, so
 * the visual suite can read the screen buffer (the WebGL renderer paints to
 * a canvas, so the text is not in the DOM). Returns the matching unpublish.
 */
function publishTerm(term: XTerm): () => void {
  const w = window as unknown as { __nest?: { term: XTerm } }
  w.__nest = { term }
  return () => {
    if (w.__nest?.term === term) delete w.__nest
  }
}

function isFileDrag(e: ReactDragEvent): boolean {
  return e.dataTransfer.types.includes('Files')
}

export function Terminal({
  windowId,
  touch = false,
  isActive,
  fontSize = 14,
  modifiers = NO_MODIFIERS,
  onModifiersUsed,
}: TerminalProps) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const historyRef = useRef<HTMLDivElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<XTerm | null>(null)
  const isActiveRef = useRef(isActive)
  isActiveRef.current = isActive
  const modifiersRef = useRef(modifiers)
  modifiersRef.current = modifiers
  const onModifiersUsedRef = useRef(onModifiersUsed)
  onModifiersUsedRef.current = onModifiersUsed
  const fitRef = useRef<(() => void) | null>(null)
  const fontSizeRef = useRef(fontSize)
  fontSizeRef.current = fontSize
  const { send, onMessage, status } = useSocketContext()
  const everConnectedRef = useRef(false)
  const prevStatusRef = useRef<typeof status | null>(null)
  const [detached, setDetached] = useState(false)
  const detachedRef = useRef(detached)
  detachedRef.current = detached

  const [dragging, setDragging] = useState(false)
  const [uploadStatus, setUploadStatus] = useState<UploadStatus | null>(null)
  // Select mode: the frozen text, or null when the live terminal shows.
  const [selecting, setSelecting] = useState<string | null>(null)
  const selectScrollRef = useRef<HTMLDivElement>(null)
  const [copied, setCopied] = useState(false)
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const dragDepth = useRef(0)
  const uploadsInFlight = useRef(0)
  const errorTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Whether the scroll container is pinned to the bottom.
  const stickRef = useRef(true)
  // Pixels to keep below the fold when pinned (composer mode on touch); the
  // main effect installs the real function once the xterm exists.
  const insetRef = useRef<() => number>(() => 0)
  // A smooth programmatic scroll fires scroll events on the way; ignore them
  // for the stick check until it lands.
  const suppressStickUntil = useRef(0)

  const scrollToBottom = (smooth = false) => {
    const el = scrollRef.current
    if (!el) return
    requestAnimationFrame(() => {
      const top = Math.max(0, el.scrollHeight - el.clientHeight - insetRef.current())
      if (smooth) {
        suppressStickUntil.current = Date.now() + 600
        el.scrollTo({ top, behavior: 'smooth' })
      } else {
        el.scrollTop = top
      }
    })
  }

  const maybeScrollToBottom = () => {
    if (stickRef.current) scrollToBottom()
  }

  useEffect(() => {
    const prev = prevStatusRef.current
    prevStatusRef.current = status
    if (status !== 'connected') return
    const isReconnect = prev !== null && prev !== 'connected' && everConnectedRef.current
    everConnectedRef.current = true
    const term = termRef.current
    if (!isReconnect || detachedRef.current || !term) return
    send({ type: 'terminal:attach', windowId, cols: term.cols, rows: term.rows })
  }, [status, windowId, send])

  useEffect(() => {
    if (!isActive || !termRef.current) return
    if (touch) {
      const ta = document.querySelector<HTMLTextAreaElement>('[data-composer] textarea')
      if (ta) { ta.focus(); return }
    }
    termRef.current.focus()
  }, [isActive])

  useEffect(() => {
    const term = termRef.current
    if (!term || term.options.fontSize === fontSize) return
    term.options.fontSize = fontSize
    if (historyRef.current) historyRef.current.style.fontSize = `${fontSize}px`
    requestAnimationFrame(() => fitRef.current?.())
  }, [fontSize])

  useEffect(() => {
    return () => {
      if (errorTimer.current) clearTimeout(errorTimer.current)
      if (copiedTimer.current) clearTimeout(copiedTimer.current)
    }
  }, [])

  // Main effect: mount xterm, wire messages, manage history DOM.
  useEffect(() => {
    if (!containerRef.current || !scrollRef.current || !historyRef.current) return

    const term = new XTerm({
      theme: THEME,
      fontFamily: MONO_FONT,
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
    term.open(containerRef.current)
    // Click/tap a URL on the live screen to open it (all platforms).
    term.loadAddon(new WebLinksAddon())
    // WebGL on desktop only. The DOM renderer leaves text in the DOM so
    // native long-press selection works on phones. WebGL paints to a canvas
    // where the browser can't select text at all.
    let webgl: WebglAddon | null = null
    if (!touch) {
      try {
        webgl = new WebglAddon()
        webgl.onContextLoss(() => { webgl?.dispose(); webgl = null })
        term.loadAddon(webgl)
      } catch {
        webgl = null
      }
    }
    requestAnimationFrame(() => {
      if (touch) {
        const ta = document.querySelector<HTMLTextAreaElement>('[data-composer] textarea')
        if (ta) { ta.focus(); return }
      }
      term.focus()
    })

    const container = containerRef.current
    const scrollEl = scrollRef.current
    const historyEl = historyRef.current
    let reported: TerminalDims | null = null
    let historyCount = 0

    const fit = (): boolean => {
      if (!canFit(container.clientWidth, container.clientHeight)) return false
      fitAddon.fit()
      return true
    }

    const fitAndReportSize = () => {
      if (!fit()) return
      const next = nextResize(reported, term.cols, term.rows)
      if (!next) return
      reported = next
      send({ type: 'terminal:resize', windowId, ...next })
      maybeScrollToBottom()
    }
    fitRef.current = fitAndReportSize

    requestAnimationFrame(() => {
      fit()
      reported = { cols: term.cols, rows: term.rows }
      send({ type: 'terminal:attach', windowId, ...reported })
    })

    const observer = new ResizeObserver(() => {
      requestAnimationFrame(fitAndReportSize)
    })
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
        if (w !== lastW) { lastW = w; fullH = 0 }
        if (h > fullH) {
          fullH = h
          container.style.setProperty('--xterm-full-h', `${fullH}px`)
        }
      }
      maybeScrollToBottom()
    })
    scrollObserver.observe(scrollEl)

    const handleScroll = () => {
      if (Date.now() < suppressStickUntil.current) return
      stickRef.current = scrollEl.scrollTop + scrollEl.clientHeight >= scrollEl.scrollHeight - insetRef.current() - 4
    }
    scrollEl.addEventListener('scroll', handleScroll, { passive: true })

    // Pixels of the xterm screen to keep below the fold while the Composer has
    // focus: everything under the last real output row (prompt box, status bar,
    // trailing blanks). The cursor row is never output, so the walk starts above it.
    const bottomInset = (): number => {
      if (!touch) return 0
      if (!document.querySelector('[data-composer]:focus-within')) return 0
      const buf = term.buffer.active
      const text = (r: number) => buf.getLine(r)?.translateToString(true) ?? ''
      let row = buf.baseY + buf.cursorY - 1
      while (row >= 0) {
        const t = text(row)
        if (t !== '' && !SEPARATOR.test(t) && !PROMPT.test(t)) break
        row--
      }
      const outputRow = row - buf.baseY
      // Measure rather than assume: the DOM renderer keeps one div per row in
      // .xterm-rows, and xterm's screen can overflow the container's padding.
      const rowEl = term.element?.querySelector('.xterm-rows')?.children[outputRow] as HTMLElement | undefined
      if (rowEl) {
        const rowBottom = rowEl.getBoundingClientRect().bottom - scrollEl.getBoundingClientRect().top + scrollEl.scrollTop
        return Math.max(0, scrollEl.scrollHeight - rowBottom)
      }
      // No output row on screen (or no DOM rows): park the whole screen.
      const screen = term.element?.querySelector<HTMLElement>('.xterm-screen')
      const cellH = screen ? screen.clientHeight / Math.max(term.rows, 1) : 0
      return (term.rows - outputRow - 1) * cellH
    }
    insetRef.current = bottomInset

    // Switching between the Composer and the terminal moves the pin: composer
    // mode parks the prompt box below the fold, terminal mode brings it back.
    // Only a pinned view follows. Locking the phone or switching apps blurs
    // and refocuses the input too, and a reader scrolled up must stay put.
    let pinRaf = 0
    const onFocusChange = () => {
      if (!touch) return
      cancelAnimationFrame(pinRaf)
      pinRaf = requestAnimationFrame(() => { if (stickRef.current) scrollToBottom(true) })
    }
    document.addEventListener('focusin', onFocusChange)
    document.addEventListener('focusout', onFocusChange)

    /** The visible screen as logical lines: wrapped rows rejoined. */
    const visibleLogicalLines = (): string[] => {
      const buffer = term.buffer.active
      const rows: { text: string; wrapped: boolean }[] = []
      for (let i = 0; i < term.rows; i++) {
        const line = buffer.getLine(i)
        if (line) rows.push({ text: line.translateToString(true), wrapped: line.isWrapped })
      }
      return joinWrapped(rows)
    }

    // Content-relative scroll position, taken before a history swap (see
    // scrollAnchor.ts). Null when pinned: the bottom follows on its own.
    type ScrollAnchor = { kind: 'row'; row: RowAnchor } | { kind: 'screen'; offset: number }
    const contentTop = (el: Element): number =>
      el.getBoundingClientRect().top - scrollEl.getBoundingClientRect().top + scrollEl.scrollTop
    const rowText = (row: Element): string => (row.textContent === '\u00a0' ? '' : row.textContent ?? '')
    const captureAnchor = (): ScrollAnchor | null => {
      if (stickRef.current) return null
      const top = scrollEl.scrollTop
      const rows = historyEl.children
      // First history row whose bottom edge is below the viewport top.
      let lo = 0
      let hi = rows.length
      while (lo < hi) {
        const mid = (lo + hi) >> 1
        const el = rows[mid]
        if (contentTop(el) + el.getBoundingClientRect().height > top) hi = mid
        else lo = mid + 1
      }
      if (lo >= rows.length) return { kind: 'screen', offset: top - contentTop(container) }
      const texts: string[] = []
      for (let i = lo; i < rows.length && texts.length < ANCHOR_ROWS; i++) texts.push(rowText(rows[i]))
      return { kind: 'row', row: { index: lo, texts, offset: top - contentTop(rows[lo]) } }
    }
    const restoreAnchor = (anchor: ScrollAnchor) => {
      if (anchor.kind === 'screen') {
        scrollEl.scrollTop = contentTop(container) + anchor.offset
        return
      }
      const rows = historyEl.children
      const texts = Array.from(rows, rowText)
      const i = findAnchorRow(texts, anchor.row)
      // Not found (trimmed away, or the history changed shape): the pixel
      // position stands, which is what happened before anchoring existed.
      if (i < 0) return
      scrollEl.scrollTop = contentTop(rows[i]) + anchor.row.offset
    }

    const appendHistoryLines = (lines: string[]) => {
      if (lines.length === 0) return
      const frag = document.createDocumentFragment()
      const rows: HTMLElement[] = []
      for (const line of lines) {
        const row = document.createElement('div')
        row.innerHTML = ansiLineToHtml(line, PALETTE) || '&nbsp;'
        frag.appendChild(row)
        rows.push(row)
      }
      linkifyRows(rows, term.cols)
      historyEl.appendChild(frag)
      historyCount += lines.length
      while (historyCount > MAX_HISTORY_LINES && historyEl.firstChild) {
        historyEl.removeChild(historyEl.firstChild)
        historyCount--
      }
      maybeScrollToBottom()
    }

    const unsubscribe = onMessage((msg) => {
      if (!('windowId' in msg) || msg.windowId !== windowId) return
      if (msg.type === 'terminal:output') {
        term.write(msg.data, () => {
          maybeScrollToBottom()
        })
      }
      if (msg.type === 'terminal:history') {
        if (msg.reset) {
          const anchor = captureAnchor()
          historyEl.replaceChildren()
          historyCount = 0
          appendHistoryLines(msg.lines)
          if (anchor) restoreAnchor(anchor)
        } else {
          appendHistoryLines(msg.lines)
        }
      }
      if (msg.type === 'terminal:detached') {
        setDetached(true)
      }
    })

    const withModifiers = (data: string): string => {
      const mods = modifiersRef.current
      if (!mods.ctrl && !mods.alt) return data
      onModifiersUsedRef.current?.()
      return applyModifiers(data, mods)
    }

    // xterm.js doesn't support the kitty keyboard protocol, so Shift+Enter
    // sends plain \r like Enter. Claude Code's input widget uses CSI u
    // encoding (ESC[13;2u) to tell them apart. Intercept here so multiline
    // input works through Nest the same way it does in a local terminal.
    term.attachCustomKeyEventHandler((e) => {
      if (e.type === 'keydown' && e.key === 'Enter' && e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) {
        send({ type: 'terminal:input', windowId, data: '\x1b[13;2u' })
        return false
      }
      return true
    })

    const dataSub = term.onData((data) => {
      send({ type: 'terminal:input', windowId, data: withModifiers(data) })
    })

    // Copy on select: a drag or long-press selection lands on the system
    // clipboard without a further keystroke. OSC 52 (ClipboardAddon) and
    // Cmd/Ctrl+C keep working as before.
    let copyTimer: ReturnType<typeof setTimeout> | null = null
    const selectionSub = term.onSelectionChange(() => {
      if (copyTimer) clearTimeout(copyTimer)
      copyTimer = setTimeout(() => {
        copyTimer = null
        const text = term.getSelection()
        if (!text || typeof navigator.clipboard?.writeText !== 'function') return
        navigator.clipboard.writeText(text).catch(() => {})
      }, COPY_ON_SELECT_MS)
    })

    const handleSendKeys = (e: Event) => {
      if (!isActiveRef.current) return
      const detail = (e as CustomEvent).detail as string
      term.focus()
      send({ type: 'terminal:input', windowId, data: withModifiers(detail) })
    }
    const handlePaste = (e: Event) => {
      if (!isActiveRef.current) return
      term.focus()
      term.paste((e as CustomEvent).detail as string)
    }
    let submitTimer: ReturnType<typeof setTimeout> | null = null
    const handleSubmit = (e: Event) => {
      if (!isActiveRef.current) return
      const text = (e as CustomEvent).detail as string
      if (text) term.paste(text)
      if (submitTimer) clearTimeout(submitTimer)
      submitTimer = setTimeout(() => {
        submitTimer = null
        send({ type: 'terminal:input', windowId, data: '\r' })
      }, text ? 40 : 0)
    }
    // Select mode: freeze scrollback plus screen as plain text (see
    // selectMode.ts). The toolbar key toggles it; the overlay's Done closes it.
    const handleSelectMode = () => {
      if (!isActiveRef.current) return
      setSelecting((current) => {
        if (current !== null) return null
        const history = Array.from(historyEl.children, (row) => row.textContent ?? '')
        return snapshotText(history, visibleLogicalLines())
      })
    }
    window.addEventListener('nest:sendkeys', handleSendKeys)
    window.addEventListener('nest:paste', handlePaste)
    window.addEventListener('nest:submit', handleSubmit)
    window.addEventListener('nest:select-mode', handleSelectMode)

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

    termRef.current = term

    return () => {
      webgl?.dispose()
      webgl = null
      fitRef.current = null
      window.removeEventListener('nest:sendkeys', handleSendKeys)
      window.removeEventListener('nest:paste', handlePaste)
      window.removeEventListener('nest:submit', handleSubmit)
      window.removeEventListener('nest:select-mode', handleSelectMode)
      if (submitTimer) clearTimeout(submitTimer)
      if (copyTimer) clearTimeout(copyTimer)
      scrollEl.removeEventListener('scroll', handleScroll)
      container.removeEventListener('wheel', handleWheel, { capture: true })
      document.removeEventListener('focusin', onFocusChange)
      document.removeEventListener('focusout', onFocusChange)
      cancelAnimationFrame(pinRaf)
      insetRef.current = () => 0
      selectionSub.dispose()
      dataSub.dispose()
      unsubscribe()
      observer.disconnect()
      scrollObserver.disconnect()
      term.dispose()
    }
  }, [windowId, send, onMessage])

  // Declared after the main effect so the term exists when both run on
  // mount; on a switch the outgoing terminal's cleanup runs before the
  // incoming one publishes.
  useEffect(() => {
    const term = termRef.current
    if (!isActive || !term) return
    return publishTerm(term)
  }, [isActive])

  const flashUploadError = useCallback((message: string) => {
    setUploadStatus({ kind: 'error', message })
    if (errorTimer.current) clearTimeout(errorTimer.current)
    errorTimer.current = setTimeout(() => {
      errorTimer.current = null
      setUploadStatus((current) => (current?.kind === 'error' ? null : current))
    }, UPLOAD_ERROR_FLASH_MS)
  }, [])

  const uploadFiles = useCallback(
    async (files: File[]) => {
      const images = pickImageFiles(files)
      if (images.length === 0) {
        flashUploadError('only PNG, JPEG, GIF, or WEBP images can be uploaded')
        return
      }
      uploadsInFlight.current += 1
      setUploadStatus({
        kind: 'uploading',
        message: images.length > 1 ? `uploading ${images.length} images…` : 'uploading…',
      })
      try {
        for (const image of images) {
          const savedPath = await uploadImage(image)
          send({ type: 'terminal:input', windowId, data: pathToTerminalInput(savedPath) })
        }
        uploadsInFlight.current -= 1
        if (uploadsInFlight.current === 0) setUploadStatus(null)
      } catch (err) {
        uploadsInFlight.current -= 1
        flashUploadError(`upload failed: ${err instanceof Error ? err.message : String(err)}`)
      } finally {
        termRef.current?.focus()
      }
    },
    [windowId, send, flashUploadError],
  )

  useEffect(() => {
    const handleUpload = (e: Event) => {
      if (!isActiveRef.current) return
      void uploadFiles((e as CustomEvent).detail as File[])
    }
    window.addEventListener('nest:upload', handleUpload)
    return () => window.removeEventListener('nest:upload', handleUpload)
  }, [uploadFiles])

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const handlePaste = (e: ClipboardEvent) => {
      const images = imageFilesFromClipboard(e.clipboardData?.items)
      if (images.length === 0) return
      e.preventDefault()
      e.stopPropagation()
      void uploadFiles(images)
    }
    container.addEventListener('paste', handlePaste, { capture: true })
    return () => container.removeEventListener('paste', handlePaste, { capture: true })
  }, [uploadFiles])

  const handleDragEnter = (e: ReactDragEvent) => {
    if (!isFileDrag(e)) return
    e.preventDefault()
    dragDepth.current += 1
    setDragging(true)
  }

  const handleDragOver = (e: ReactDragEvent) => {
    if (!isFileDrag(e)) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
  }

  const handleDragLeave = (e: ReactDragEvent) => {
    if (!isFileDrag(e)) return
    dragDepth.current = Math.max(0, dragDepth.current - 1)
    if (dragDepth.current === 0) setDragging(false)
  }

  const handleDrop = (e: ReactDragEvent) => {
    if (!isFileDrag(e)) return
    e.preventDefault()
    dragDepth.current = 0
    setDragging(false)
    void uploadFiles(Array.from(e.dataTransfer.files))
  }

  const handleReconnect = () => {
    setDetached(false)
    const term = termRef.current
    send({ type: 'terminal:attach', windowId, cols: term?.cols, rows: term?.rows })
  }

  // Entering select mode: drop the keyboard so the text gets the whole
  // screen, and open the overlay at the same scroll offset so the terminal
  // looks paused rather than replaced. Leaving: hand focus back.
  useEffect(() => {
    if (selecting === null) return
    const live = scrollRef.current
    const frozen = selectScrollRef.current
    if (live && frozen) frozen.scrollTop = live.scrollTop
    const focused = document.activeElement
    if (focused instanceof HTMLElement) focused.blur()
    return () => {
      setCopied(false)
      if (touch) {
        document.querySelector<HTMLTextAreaElement>('[data-composer] textarea')?.focus()
      } else {
        termRef.current?.focus()
      }
    }
  }, [selecting])

  /** Copy the native selection inside the overlay, or the whole snapshot if there is none. */
  const copyFromSelectMode = () => {
    if (selecting === null) return
    const sel = window.getSelection()
    const inOverlay = sel && sel.rangeCount > 0 && selectScrollRef.current?.contains(sel.anchorNode)
    const text = inOverlay ? sel.toString() : ''
    navigator.clipboard?.writeText(text || selecting).catch(() => {})
    setCopied(true)
    if (copiedTimer.current) clearTimeout(copiedTimer.current)
    copiedTimer.current = setTimeout(() => {
      copiedTimer.current = null
      setCopied(false)
    }, COPIED_FLASH_MS)
  }

  const selectButton: React.CSSProperties = {
    flexShrink: 0,
    height: 32,
    padding: '0 12px',
    borderRadius: 8,
    border: '1px solid var(--key-border)',
    background: 'var(--key-bg)',
    color: 'var(--key-text)',
    fontFamily: MONO_FONT,
    fontSize: 12,
    cursor: 'pointer',
    touchAction: 'manipulation',
    userSelect: 'none',
    WebkitUserSelect: 'none',
  }

  return (
    <div
      data-testid="terminal"
      // Every opened session keeps its terminal mounted (hidden when not
      // active); only the active one answers to the "terminal" test id, so
      // the visual suite's getByTestId('terminal') is unique.
      {...(isActive ? {} : { 'data-testid': 'terminal-inactive' })}
      style={{ position: 'relative', width: '100%', height: '100%', display: 'flex', flexDirection: 'column' }}
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
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
          background: THEME.background,
        }}
      >
        <div
          ref={historyRef}
          style={{
            fontFamily: MONO_FONT,
            fontSize,
            lineHeight: 1.4,
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-all',
            padding: '0 8px',
            color: THEME.foreground,
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
        />
      </div>
      {selecting !== null && (
        <div
          data-testid="select-mode"
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            flexDirection: 'column',
            background: THEME.background,
            zIndex: 5,
          }}
        >
          <div
            style={{
              flexShrink: 0,
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '6px 8px',
              background: 'var(--surface)',
              borderBottom: '1px solid var(--border)',
              fontFamily: MONO_FONT,
              fontSize: 12,
            }}
          >
            <span style={{ flex: 1, color: 'var(--text-dim)', userSelect: 'none', WebkitUserSelect: 'none' }}>
              select text to copy
            </span>
            <button
              data-testid="select-mode-copy"
              onPointerDown={(e) => e.preventDefault()}
              onClick={copyFromSelectMode}
              style={selectButton}
            >
              {copied ? 'Copied' : 'Copy'}
            </button>
            <button
              data-testid="select-mode-done"
              onPointerDown={(e) => e.preventDefault()}
              onClick={() => setSelecting(null)}
              style={{ ...selectButton, color: 'var(--accent-text)', borderColor: 'var(--accent)' }}
            >
              Done
            </button>
          </div>
          <div
            ref={selectScrollRef}
            data-testid="select-mode-text"
            style={{
              flex: 1,
              minHeight: 0,
              overflowY: 'auto',
              overscrollBehavior: 'contain',
              WebkitOverflowScrolling: 'touch',
              padding: '0 8px 8px',
              fontFamily: MONO_FONT,
              fontSize,
              lineHeight: 1.4,
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-all',
              color: THEME.foreground,
              userSelect: 'text',
              WebkitUserSelect: 'text',
              WebkitTouchCallout: 'default',
            } as React.CSSProperties}
          >
            {selecting}
          </div>
        </div>
      )}
      {dragging && (
        <div
          style={{
            position: 'absolute',
            inset: 8,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            border: '2px dashed var(--accent)',
            borderRadius: 8,
            background: 'rgba(61, 184, 169, 0.08)',
            color: 'var(--accent-text)',
            fontSize: 13,
            fontFamily: MONO_FONT,
            letterSpacing: '0.04em',
            pointerEvents: 'none',
            zIndex: 4,
          }}
        >
          drop image to upload
        </div>
      )}
      {uploadStatus && (
        <div
          style={{
            position: 'absolute',
            right: 12,
            bottom: 12,
            padding: '4px 10px',
            borderRadius: 6,
            background: 'var(--surface-raised)',
            border: `1px solid ${uploadStatus.kind === 'error' ? 'var(--danger)' : 'var(--accent)'}`,
            color: uploadStatus.kind === 'error' ? 'var(--danger)' : 'var(--accent-text)',
            fontSize: 12,
            fontFamily: MONO_FONT,
            letterSpacing: '0.02em',
            pointerEvents: 'none',
            zIndex: 6,
          }}
        >
          {uploadStatus.message}
        </div>
      )}
      {detached && (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 14,
            background: 'rgba(10, 10, 12, 0.88)',
            zIndex: 5,
          }}
        >
          <div
            style={{
              color: 'var(--text)',
              fontSize: 13,
              fontFamily: MONO_FONT,
              letterSpacing: '0.02em',
            }}
          >
            session taken over by another client
          </div>
          <button
            onClick={handleReconnect}
            style={{
              background: 'var(--accent-dim)',
              border: '1px solid var(--accent)',
              color: 'var(--accent)',
              fontSize: 12,
              padding: '6px 14px',
              borderRadius: 6,
              cursor: 'pointer',
              fontFamily: MONO_FONT,
            }}
          >
            reconnect
          </button>
        </div>
      )}
      {status !== 'connected' && (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'rgba(10, 10, 12, 0.72)',
            color: 'var(--text-dim)',
            fontSize: 13,
            fontFamily: MONO_FONT,
            letterSpacing: '0.04em',
            pointerEvents: 'none',
          }}
        >
          {everConnectedRef.current ? 'reconnecting…' : 'connecting…'}
        </div>
      )}
    </div>
  )
}
