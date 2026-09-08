// The layers a Terminal draws over its screen: select mode, the image
// drop target and upload status, a lost pty, and a lost socket. Each is a
// leaf that renders from props; Terminal.tsx decides which are shown.

import { useEffect, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { MONO_FONT, THEME } from '../theme'
import type { UploadStatus } from '../hooks/useImageUpload'

const COPIED_FLASH_MS = 1500

const selectButton: CSSProperties = {
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

interface SelectModeOverlayProps {
  /** The frozen scrollback plus screen (selectMode.ts). */
  text: string
  /** The live view's scroll offset when the mode opened, so the terminal looks paused, not replaced. */
  scrollTop: number
  fontSize: number
  onDone: () => void
  /** Where typing resumes once the overlay closes. */
  restoreFocus: () => void
}

/**
 * Select mode: the terminal as plain text the browser owns, so long-press
 * selection works. Copy with nothing selected copies the whole snapshot.
 */
export function SelectModeOverlay({ text, scrollTop, fontSize, onDone, restoreFocus }: SelectModeOverlayProps) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const [copied, setCopied] = useState(false)
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Opening: drop the keyboard so the text gets the whole screen. Closing:
  // hand focus back.
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollTop
    const focused = document.activeElement
    if (focused instanceof HTMLElement) focused.blur()
    return () => {
      if (copiedTimer.current) clearTimeout(copiedTimer.current)
      restoreFocus()
    }
    // Runs once per opening; the offset and the focus target are read then.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /** Copy the native selection inside the overlay, or the whole snapshot if there is none. */
  const copy = () => {
    const sel = window.getSelection()
    const inOverlay = sel && sel.rangeCount > 0 && scrollRef.current?.contains(sel.anchorNode)
    const selected = inOverlay ? sel.toString() : ''
    navigator.clipboard?.writeText(selected || text).catch(() => {})
    setCopied(true)
    if (copiedTimer.current) clearTimeout(copiedTimer.current)
    copiedTimer.current = setTimeout(() => {
      copiedTimer.current = null
      setCopied(false)
    }, COPIED_FLASH_MS)
  }

  return (
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
          onClick={copy}
          style={selectButton}
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
        <button
          data-testid="select-mode-done"
          onPointerDown={(e) => e.preventDefault()}
          onClick={onDone}
          style={{ ...selectButton, color: 'var(--accent-text)', borderColor: 'var(--accent)' }}
        >
          Done
        </button>
      </div>
      <div
        ref={scrollRef}
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
        } as CSSProperties}
      >
        {text}
      </div>
    </div>
  )
}

interface UploadOverlayProps {
  /** An image is being dragged over the terminal. */
  dragging: boolean
  status: UploadStatus | null
}

/** The drop target while an image is dragged over, and the upload's progress or failure. */
export function UploadOverlay({ dragging, status }: UploadOverlayProps) {
  return (
    <>
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
      {status && (
        <div
          style={{
            position: 'absolute',
            right: 12,
            bottom: 12,
            padding: '4px 10px',
            borderRadius: 6,
            background: 'var(--surface-raised)',
            border: `1px solid ${status.kind === 'error' ? 'var(--danger)' : 'var(--accent)'}`,
            color: status.kind === 'error' ? 'var(--danger)' : 'var(--accent-text)',
            fontSize: 12,
            fontFamily: MONO_FONT,
            letterSpacing: '0.02em',
            pointerEvents: 'none',
            zIndex: 6,
          }}
        >
          {status.message}
        </div>
      )}
    </>
  )
}

interface DetachedOverlayProps {
  /** Why the pty is gone: another client took the window, or the session ended. */
  reason: 'takenOver' | 'exited'
  onReattach: () => void
}

/** The pty is gone; the user decides whether to ask for it back. */
export function DetachedOverlay({ reason, onReattach }: DetachedOverlayProps) {
  return (
    <div
      data-testid="terminal-detached"
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
        {reason === 'takenOver' ? 'session taken over by another client' : 'session ended'}
      </div>
      <button
        onClick={onReattach}
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
        {reason === 'takenOver' ? 'reconnect' : 'reattach'}
      </button>
    </div>
  )
}

/** The socket is down. A terminal that has held a pty is reconnecting; one that never has is still connecting. */
export function ConnectionOverlay({ reconnecting }: { reconnecting: boolean }) {
  return (
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
      {reconnecting ? 'reconnecting…' : 'connecting…'}
    </div>
  )
}
