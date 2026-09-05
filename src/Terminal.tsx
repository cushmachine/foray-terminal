import { useCallback, useEffect, useRef, useState } from 'react'
import type { DragEvent as ReactDragEvent } from 'react'
import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { ClipboardAddon } from '@xterm/addon-clipboard'
import '@xterm/xterm/css/xterm.css'
import type { UseSocketReturn } from './hooks/useSocket'
import { imageFilesFromClipboard, pathToTerminalInput, pickImageFiles, uploadImage } from './imageUpload'
import { canFit, nextResize, type TerminalDims } from './terminalSize'
import { NO_MODIFIERS, applyModifiers, type Modifiers } from './keys'
import { paletteFromTheme, ansiLineToHtml, type Palette } from './ansi'

interface TerminalProps {
  windowId: number
  socket: UseSocketReturn
  isActive?: boolean
  fontSize?: number
  modifiers?: Modifiers
  onModifiersUsed?: () => void
}

const THEME = {
  background: '#0a0a0c',
  foreground: '#d4d4d8',
  cursor: '#3db8a9',
  cursorAccent: '#0a0a0c',
  selectionBackground: '#3db8a933',
  black: '#1a1a21',
  red: '#d4634f',
  green: '#3db8a9',
  yellow: '#e09a3c',
  blue: '#5e6ad2',
  magenta: '#b07cd8',
  cyan: '#3db8a9',
  white: '#d4d4d8',
  brightBlack: '#636370',
  brightRed: '#e8796a',
  brightGreen: '#5cd4c4',
  brightYellow: '#f0b45c',
  brightBlue: '#8b93e8',
  brightMagenta: '#c99de8',
  brightCyan: '#5cd4c4',
  brightWhite: '#fafafa',
}

const PALETTE: Palette = paletteFromTheme(THEME)
const MONO_FONT = "'JetBrains Mono', 'SF Mono', 'Fira Code', 'Cascadia Code', monospace"
const MAX_HISTORY_LINES = 3000

interface UploadStatus {
  kind: 'uploading' | 'error'
  message: string
}

const UPLOAD_ERROR_FLASH_MS = 4000

function isFileDrag(e: ReactDragEvent): boolean {
  return e.dataTransfer.types.includes('Files')
}

export function Terminal({
  windowId,
  socket,
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
  const { send, onMessage, status } = socket
  const everConnectedRef = useRef(false)
  const prevStatusRef = useRef<typeof status | null>(null)
  const [detached, setDetached] = useState(false)
  const detachedRef = useRef(detached)
  detachedRef.current = detached

  const [dragging, setDragging] = useState(false)
  const [uploadStatus, setUploadStatus] = useState<UploadStatus | null>(null)
  const dragDepth = useRef(0)
  const uploadsInFlight = useRef(0)
  const errorTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Whether the scroll container is pinned to the bottom.
  const stickRef = useRef(true)

  const scrollToBottom = () => {
    const el = scrollRef.current
    if (el) requestAnimationFrame(() => { el.scrollTop = el.scrollHeight })
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
    if (isActive && termRef.current) termRef.current.focus()
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
      scrollback: 0,
      allowTransparency: true,
      convertEol: true,
    })

    const fitAddon = new FitAddon()
    term.loadAddon(fitAddon)
    term.loadAddon(new ClipboardAddon())
    term.open(containerRef.current)
    requestAnimationFrame(() => term.focus())

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

    const handleScroll = () => {
      stickRef.current = scrollEl.scrollTop + scrollEl.clientHeight >= scrollEl.scrollHeight - 4
    }
    scrollEl.addEventListener('scroll', handleScroll, { passive: true })

    const appendHistoryLines = (lines: string[]) => {
      if (lines.length === 0) return
      const frag = document.createDocumentFragment()
      for (const line of lines) {
        const row = document.createElement('div')
        row.innerHTML = ansiLineToHtml(line, PALETTE) || '&nbsp;'
        frag.appendChild(row)
      }
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
        term.write(msg.data, maybeScrollToBottom)
      }
      if (msg.type === 'terminal:history') {
        if (msg.reset) {
          historyEl.replaceChildren()
          historyCount = 0
        }
        appendHistoryLines(msg.lines)
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

    const dataSub = term.onData((data) => {
      send({ type: 'terminal:input', windowId, data: withModifiers(data) })
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
    window.addEventListener('nest:sendkeys', handleSendKeys)
    window.addEventListener('nest:paste', handlePaste)
    window.addEventListener('nest:submit', handleSubmit)

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
      fitRef.current = null
      window.removeEventListener('nest:sendkeys', handleSendKeys)
      window.removeEventListener('nest:paste', handlePaste)
      window.removeEventListener('nest:submit', handleSubmit)
      if (submitTimer) clearTimeout(submitTimer)
      scrollEl.removeEventListener('scroll', handleScroll)
      container.removeEventListener('wheel', handleWheel, { capture: true })
      dataSub.dispose()
      unsubscribe()
      observer.disconnect()
      term.dispose()
    }
  }, [windowId, send, onMessage])

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

  return (
    <div
      style={{ position: 'relative', width: '100%', height: '100%' }}
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <div
        ref={scrollRef}
        style={{
          height: '100%',
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
          }}
        />
        <div
          ref={containerRef}
          style={{
            width: '100%',
            height: '100%',
            padding: 8,
          }}
        />
      </div>
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
