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

interface TerminalProps {
  windowId: number
  socket: UseSocketReturn
  isActive?: boolean
  /** Terminal font size in px. Changing it re-measures and refits. */
  fontSize?: number
  /** Sticky modifiers armed from the key toolbar; applied to the next input. */
  modifiers?: Modifiers
  /** Called once armed modifiers have been applied, so the toolbar can disarm. */
  onModifiersUsed?: () => void
}

// Touch fling tuning. Velocities are px per ms; friction is per 16ms frame,
// so 0.98 lets a flick glide for a second or two before fading out.
const FLING_MIN_VELOCITY = 0.15
const FLING_STOP_VELOCITY = 0.02
const FLING_FRICTION = 0.98

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

/** Badge shown in the terminal corner while an image upload is in flight or just failed. */
interface UploadStatus {
  kind: 'uploading' | 'error'
  message: string
}

/** How long an upload error badge stays visible. */
const UPLOAD_ERROR_FLASH_MS = 4000

/** True when a drag carries files (as opposed to text/links being dragged around). */
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
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<XTerm | null>(null)
  // Several terminals can be mounted (one per opened session, hidden when
  // not active). Toolbar events are window-wide, so each terminal must
  // check it's the active one before acting, or Ctrl-C would go to all.
  const isActiveRef = useRef(isActive)
  isActiveRef.current = isActive
  const modifiersRef = useRef(modifiers)
  modifiersRef.current = modifiers
  const onModifiersUsedRef = useRef(onModifiersUsed)
  onModifiersUsedRef.current = onModifiersUsed
  // The fit-and-report routine lives inside the mount effect; expose it so
  // the font-size effect can trigger a refit without recreating the terminal.
  const fitRef = useRef<(() => void) | null>(null)
  const fontSizeRef = useRef(fontSize)
  fontSizeRef.current = fontSize
  const { send, onMessage, status } = socket
  const everConnectedRef = useRef(false)
  const prevStatusRef = useRef<typeof status | null>(null)
  // Set when another client takes over this window (terminal:detached).
  // Cleared when the user clicks "reconnect", which re-sends terminal:attach.
  const [detached, setDetached] = useState(false)
  const detachedRef = useRef(detached)
  detachedRef.current = detached

  // Drag-and-drop / paste image upload state. `dragging` drives the
  // drop-zone overlay; `uploadStatus` the small "uploading…" / error badge.
  const [dragging, setDragging] = useState(false)
  const [uploadStatus, setUploadStatus] = useState<UploadStatus | null>(null)
  // dragenter/dragleave fire for every child element the pointer crosses,
  // so track nesting depth and only hide the overlay when it returns to 0.
  const dragDepth = useRef(0)
  // Uploads in flight, so one finishing doesn't clear the badge for another.
  const uploadsInFlight = useRef(0)
  const errorTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Re-attach after a reconnect. The server drops every pty the moment a
  // socket closes, so a fresh connection has nothing for this window until
  // we ask again. Phones close the socket on every app switch, which made
  // the terminal go dead until a reload. A window that was deliberately
  // taken over by another client is left alone: the overlay stays up and
  // the user decides whether to take it back.
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
    // Cell metrics update on the next frame; fit after that.
    requestAnimationFrame(() => fitRef.current?.())
  }, [fontSize])

  useEffect(() => {
    return () => {
      if (errorTimer.current) clearTimeout(errorTimer.current)
    }
  }, [])

  useEffect(() => {
    if (!containerRef.current) return

    const term = new XTerm({
      theme: THEME,
      fontFamily: "'JetBrains Mono', 'SF Mono', 'Fira Code', 'Cascadia Code', monospace",
      fontSize: fontSizeRef.current,
      lineHeight: 1.4,
      cursorStyle: 'bar',
      cursorBlink: true,
      scrollback: 5000,
      allowTransparency: true,
      convertEol: true,
    })

    const fitAddon = new FitAddon()
    term.loadAddon(fitAddon)
    term.loadAddon(new ClipboardAddon())
    term.open(containerRef.current)
    requestAnimationFrame(() => term.focus())

    const container = containerRef.current
    // Last size the server was told about, so repeats are dropped.
    let reported: TerminalDims | null = null

    // Fit to the container, but only while it actually has a size. When this
    // terminal is hidden (another session is active, or the mobile "files"
    // view is up) the container is 0x0 and the fit addon would shrink the
    // pty to a handful of cells. The ResizeObserver fires again when the
    // container is shown, and the fit happens then.
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
    }
    fitRef.current = fitAndReportSize

    // Fit once, then attach with the fitted size so the pty is spawned at
    // the dimensions we'll actually use. Attaching first would have tmux
    // draw at 80x24 and immediately redraw after the resize.
    requestAnimationFrame(() => {
      fit()
      reported = { cols: term.cols, rows: term.rows }
      // history: this xterm is empty, so ask for the scrollback it missed.
      // Reconnects (above) don't, or it would be duplicated.
      send({ type: 'terminal:attach', windowId, ...reported, history: true })
    })

    const observer = new ResizeObserver(() => {
      requestAnimationFrame(fitAndReportSize)
    })
    observer.observe(container)

    const unsubscribe = onMessage((msg) => {
      if (msg.type === 'terminal:output' && msg.windowId === windowId) {
        term.write(msg.data)
      }
      if (msg.type === 'terminal:detached' && msg.windowId === windowId) {
        setDetached(true)
      }
    })

    // Typed input, with any sticky Ctrl/Alt from the toolbar applied to it.
    const withModifiers = (data: string): string => {
      const mods = modifiersRef.current
      if (!mods.ctrl && !mods.alt) return data
      onModifiersUsedRef.current?.()
      return applyModifiers(data, mods)
    }

    const dataSub = term.onData((data) => {
      send({ type: 'terminal:input', windowId, data: withModifiers(data) })
    })

    // Special/mobile keys from KeyToolbar arrive as window-level custom
    // events (KeyToolbar itself has no knowledge of windowId or the socket).
    const handleSendKeys = (e: Event) => {
      if (!isActiveRef.current) return
      const detail = (e as CustomEvent).detail as string
      term.focus()
      send({ type: 'terminal:input', windowId, data: withModifiers(detail) })
    }
    // Paste goes through xterm so bracketed-paste mode is honoured: Claude
    // Code turns it on, and without it a multi-line paste runs line by line.
    const handlePaste = (e: Event) => {
      if (!isActiveRef.current) return
      term.focus()
      term.paste((e as CustomEvent).detail as string)
    }
    window.addEventListener('nest:sendkeys', handleSendKeys)
    window.addEventListener('nest:paste', handlePaste)

    // Touch scrolling. xterm.js 6 ships VS Code's gesture code but never
    // wires it up, so a drag on a phone scrolls nothing; and with tmux out
    // of mouse mode (scrollback lives here now) nothing upstream scrolls
    // either. Turn vertical drags into scrollLines against the local
    // buffer, the same path the wheel takes on desktop. The container's
    // touch-action: none stops the browser panning the page, or xterm's
    // own viewport div, underneath us.
    let touchLastY: number | null = null
    let touchLastT = 0
    // px per ms, positive = finger moving up = scrolling toward newer lines.
    let touchVelocity = 0
    // Sub-row movement carried between events so slow drags still add up.
    let touchCarry = 0
    let flingFrame: number | null = null

    const rowHeightPx = (): number => {
      const screen = term.element?.querySelector<HTMLElement>('.xterm-screen')
      const h = screen?.clientHeight || container.clientHeight
      return h / Math.max(term.rows, 1)
    }
    const scrollByPx = (px: number) => {
      const delta = px + touchCarry
      const rowH = rowHeightPx()
      const lines = Math.trunc(delta / rowH)
      touchCarry = delta - lines * rowH
      if (lines !== 0) term.scrollLines(lines)
    }
    const cancelFling = () => {
      if (flingFrame !== null) cancelAnimationFrame(flingFrame)
      flingFrame = null
    }

    const handleTouchStart = (e: TouchEvent) => {
      cancelFling()
      touchLastY = e.touches.length === 1 ? e.touches[0].clientY : null
      touchLastT = e.timeStamp
      touchVelocity = 0
      touchCarry = 0
    }
    const handleTouchMove = (e: TouchEvent) => {
      if (touchLastY === null || e.touches.length !== 1) return
      const y = e.touches[0].clientY
      const dy = touchLastY - y
      const dt = Math.max(e.timeStamp - touchLastT, 1)
      // Smoothed so one jittery final sample can't dictate the fling.
      touchVelocity = touchVelocity * 0.5 + (dy / dt) * 0.5
      touchLastY = y
      touchLastT = e.timeStamp
      scrollByPx(dy)
      e.preventDefault()
    }
    // Inertia: keep scrolling after a flick, slowing with friction. A finger
    // that paused before lifting gets no fling, matching native lists.
    const handleTouchEnd = (e: TouchEvent) => {
      if (touchLastY === null) return
      touchLastY = null
      const pausedMs = e.timeStamp - touchLastT
      if (pausedMs > 100 || Math.abs(touchVelocity) < FLING_MIN_VELOCITY) return
      let v = touchVelocity
      let last = performance.now()
      const step = (now: number) => {
        const dt = now - last
        last = now
        scrollByPx(v * dt)
        v *= Math.pow(FLING_FRICTION, dt / 16)
        if (Math.abs(v) < FLING_STOP_VELOCITY) {
          flingFrame = null
          return
        }
        flingFrame = requestAnimationFrame(step)
      }
      flingFrame = requestAnimationFrame(step)
    }
    const handleTouchCancel = () => {
      touchLastY = null
    }
    container.addEventListener('touchstart', handleTouchStart, { passive: true })
    container.addEventListener('touchmove', handleTouchMove, { passive: false })
    container.addEventListener('touchend', handleTouchEnd)
    container.addEventListener('touchcancel', handleTouchCancel)

    termRef.current = term

    return () => {
      fitRef.current = null
      window.removeEventListener('nest:sendkeys', handleSendKeys)
      window.removeEventListener('nest:paste', handlePaste)
      container.removeEventListener('touchstart', handleTouchStart)
      container.removeEventListener('touchmove', handleTouchMove)
      container.removeEventListener('touchend', handleTouchEnd)
      container.removeEventListener('touchcancel', handleTouchCancel)
      cancelFling()
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

  // Upload each supported image in turn and type its saved path (plus a
  // trailing space, never a newline) into the shell. windowId is captured
  // here, so paths land in the terminal they were dropped on even if the
  // user switches sessions while the upload is still running.
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

  // Photos picked from the toolbar arrive as a window event carrying Files.
  useEffect(() => {
    const handleUpload = (e: Event) => {
      if (!isActiveRef.current) return
      void uploadFiles((e as CustomEvent).detail as File[])
    }
    window.addEventListener('nest:upload', handleUpload)
    return () => window.removeEventListener('nest:upload', handleUpload)
  }, [uploadFiles])

  // Intercept image pastes before xterm sees them. xterm listens for paste
  // on its own textarea and root element (both inside containerRef), so a
  // capture-phase listener on the container runs first and can stop the
  // event from reaching them. Pastes with no image are left untouched and
  // reach xterm as ordinary text.
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
    // Without preventDefault here the browser refuses the drop entirely.
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
        ref={containerRef}
        style={{
          width: '100%',
          height: '100%',
          padding: 8,
          // Vertical drags are handled above; never let the browser pan.
          touchAction: 'none',
        }}
      />
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
            fontFamily: "'JetBrains Mono', monospace",
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
            fontFamily: "'JetBrains Mono', monospace",
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
              fontFamily: "'JetBrains Mono', monospace",
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
              fontFamily: "'JetBrains Mono', monospace",
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
            fontFamily: "'JetBrains Mono', monospace",
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
