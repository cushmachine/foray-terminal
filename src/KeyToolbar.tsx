import { useCallback, useEffect, useRef, useState } from 'react'
import type { ChangeEvent, PointerEvent as ReactPointerEvent } from 'react'
import {
  PRIMARY_KEYS,
  SECONDARY_KEYS,
  TAP_SLOP_PX,
  repeatDelay,
  type KeyDef,
  type Modifiers,
} from './keys'
import { MONO_FONT } from './theme'

interface KeyToolbarProps {
  /** Send raw bytes to the active terminal. */
  onSend: (data: string) => void
  /** Paste text into the active terminal (honours bracketed paste). */
  onPaste: (text: string) => void
  /** Upload images to the active terminal. */
  onUpload: (files: File[]) => void
  modifiers: Modifiers
  onToggleModifier: (which: 'ctrl' | 'alt') => void
  isMobile: boolean
}

/** A short buzz on devices that support it (Android). iOS ignores it. */
function haptic(): void {
  try {
    navigator.vibrate?.(8)
  } catch {
    // Some browsers throw for vibrate outside a user gesture; not worth surfacing.
  }
}

interface PressState {
  key: KeyDef
  pointerId: number
  startX: number
  startY: number
  /** Set once movement exceeded the tap slop or the browser took the gesture. */
  cancelled: boolean
  /** Set once hold-to-repeat has fired, so pointerup doesn't send again. */
  repeated: boolean
  timer: ReturnType<typeof setTimeout> | null
}

export function KeyToolbar({
  onSend,
  onPaste,
  onUpload,
  modifiers,
  onToggleModifier,
  isMobile,
}: KeyToolbarProps) {
  const [pressed, setPressed] = useState<string | null>(null)
  const [showMore, setShowMore] = useState(false)
  const press = useRef<PressState | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)

  useEffect(() => {
    return () => {
      if (press.current?.timer) clearTimeout(press.current.timer)
    }
  }, [])

  const activate = useCallback((key: KeyDef) => {
    haptic()
    switch (key.kind) {
      case 'key':
        if (key.data !== undefined) onSend(key.data)
        break
      case 'ctrl':
      case 'alt':
        onToggleModifier(key.kind)
        break
      case 'more':
        setShowMore(v => !v)
        break
      case 'photo':
        fileInput.current?.click()
        break
      case 'paste': {
        // Must run inside the user gesture; browsers refuse otherwise.
        const clipboard = navigator.clipboard
        if (!clipboard?.readText) return
        clipboard.readText().then(
          (text) => {
            if (text) onPaste(text)
          },
          () => {
            // Permission denied or nothing readable: the terminal stays as it was.
          },
        )
        break
      }
    }
  }, [onSend, onPaste, onToggleModifier])

  const clearPress = useCallback(() => {
    const current = press.current
    if (current?.timer) clearTimeout(current.timer)
    press.current = null
    setPressed(null)
  }, [])

  // One pointer path for mouse and touch. Sending happens on release (a
  // tap) or on the repeat timer (a hold). Handling `click` as well, or
  // `touchstart` alongside `mousedown`, sent every key twice on phones.
  const handlePointerDown = useCallback((key: KeyDef) => (e: ReactPointerEvent<HTMLButtonElement>) => {
    // Keep focus (and the soft keyboard) on the terminal.
    e.preventDefault()
    if (press.current) clearPress()
    e.currentTarget.setPointerCapture(e.pointerId)
    const state: PressState = {
      key,
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      cancelled: false,
      repeated: false,
      timer: null,
    }
    press.current = state
    setPressed(key.id)

    if (key.repeat) {
      let n = 0
      const tick = () => {
        if (press.current !== state || state.cancelled) return
        state.repeated = true
        activate(key)
        state.timer = setTimeout(tick, repeatDelay(++n))
      }
      state.timer = setTimeout(tick, repeatDelay(n))
    }
  }, [activate, clearPress])

  const handlePointerMove = useCallback((e: ReactPointerEvent<HTMLButtonElement>) => {
    const state = press.current
    if (!state || state.pointerId !== e.pointerId || state.cancelled) return
    if (Math.abs(e.clientX - state.startX) > TAP_SLOP_PX || Math.abs(e.clientY - state.startY) > TAP_SLOP_PX) {
      state.cancelled = true
      if (state.timer) clearTimeout(state.timer)
      setPressed(null)
    }
  }, [])

  const handlePointerUp = useCallback((e: ReactPointerEvent<HTMLButtonElement>) => {
    const state = press.current
    if (!state || state.pointerId !== e.pointerId) return
    const fire = !state.cancelled && !state.repeated
    clearPress()
    if (fire) activate(state.key)
  }, [activate, clearPress])

  const handlePointerCancel = useCallback((e: ReactPointerEvent<HTMLButtonElement>) => {
    const state = press.current
    if (!state || state.pointerId !== e.pointerId) return
    clearPress()
  }, [clearPress])

  const handleFiles = useCallback((e: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? [])
    // Reset so picking the same photo twice in a row still fires change.
    e.target.value = ''
    if (files.length > 0) onUpload(files)
  }, [onUpload])

  const isActive = (key: KeyDef): boolean => {
    if (key.kind === 'ctrl') return modifiers.ctrl
    if (key.kind === 'alt') return modifiers.alt
    if (key.kind === 'more') return showMore
    return pressed === key.id
  }

  const renderKey = (key: KeyDef) => {
    const active = isActive(key)
    return (
      <button
        key={key.id}
        title={key.title ?? key.label}
        aria-label={key.title ?? key.label}
        aria-pressed={key.kind === 'ctrl' || key.kind === 'alt' || key.kind === 'more' ? active : undefined}
        onPointerDown={handlePointerDown(key)}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerCancel}
        onContextMenu={(e) => e.preventDefault()}
        style={{
          background: active ? 'var(--accent-dim)' : 'var(--key-bg)',
          border: `1px solid ${active ? 'var(--key-active)' : 'var(--key-border)'}`,
          borderRadius: 8,
          color: active ? 'var(--key-active)' : 'var(--key-text)',
          padding: '0 10px',
          minWidth: isMobile ? 40 : 44,
          minHeight: isMobile ? 40 : 32,
          fontSize: 13,
          fontFamily: MONO_FONT,
          fontWeight: 500,
          cursor: 'pointer',
          whiteSpace: 'nowrap',
          userSelect: 'none',
          WebkitUserSelect: 'none',
          // Effective touch-action is the intersection with the row's pan-x:
          // a sideways drag scrolls the row (and pointercancels the press),
          // a still finger holds the key.
          transition: 'background 0.08s, border-color 0.08s',
          textAlign: 'center',
          flexShrink: 0,
        }}
      >
        {key.label}
      </button>
    )
  }

  const rowStyle: React.CSSProperties = {
    display: 'flex',
    gap: 6,
    padding: '6px 8px',
    overflowX: 'auto',
    // Horizontal pans scroll the row; a press that turns into a pan is
    // cancelled by the browser via pointercancel, so nothing is sent.
    touchAction: 'pan-x',
    WebkitOverflowScrolling: 'touch',
    scrollbarWidth: 'none',
    overscrollBehaviorX: 'contain',
  }

  return (
    <div style={{
      background: 'var(--surface)',
      borderTop: '1px solid var(--border)',
      // Owns the bottom safe-area inset so the bar's surface fills down to
      // the home indicator; the inset collapses when the keyboard is up.
      paddingBottom: 'env(safe-area-inset-bottom)',
      flexShrink: 0,
    }}>
      {showMore && (
        <div style={{ ...rowStyle, paddingBottom: 0 }}>
          {SECONDARY_KEYS.map(renderKey)}
        </div>
      )}
      <div style={rowStyle}>
        {PRIMARY_KEYS.map(renderKey)}
      </div>
      <input
        ref={fileInput}
        type="file"
        accept="image/png,image/jpeg,image/gif,image/webp"
        multiple
        onChange={handleFiles}
        style={{ display: 'none' }}
        aria-hidden="true"
        tabIndex={-1}
      />
    </div>
  )
}
