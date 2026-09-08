import { useCallback, useRef } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'

interface ResizeHandleProps {
  /** Horizontal movement as a width delta: positive widens the panel. */
  onResize: (delta: number) => void
  /** The panel's current width and its bounds, reported to assistive tech. */
  value: number
  min: number
  max: number
}

/** How far one arrow-key press moves the edge. */
const KEY_STEP_PX = 16

/**
 * The drag strip on the file panel's left edge. Also a keyboard control:
 * it is a separator in the Tab order, and Left/Right move it.
 */
export function ResizeHandle({ onResize, value, min, max }: ResizeHandleProps) {
  const dragging = useRef(false)
  const lastX = useRef(0)

  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    dragging.current = true
    lastX.current = e.clientX
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
  }, [])

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    if (!dragging.current) return
    const delta = lastX.current - e.clientX
    lastX.current = e.clientX
    onResize(delta)
  }, [onResize])

  const stopDragging = useCallback(() => {
    dragging.current = false
  }, [])

  // The panel sits on the right, so its edge moving left makes it wider.
  const handleKeyDown = useCallback((e: ReactKeyboardEvent) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
    e.preventDefault()
    onResize(e.key === 'ArrowLeft' ? KEY_STEP_PX : -KEY_STEP_PX)
  }, [onResize])

  return (
    <div
      role="separator"
      aria-label="Resize file panel"
      aria-orientation="vertical"
      aria-valuenow={value}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={stopDragging}
      onPointerCancel={stopDragging}
      onKeyDown={handleKeyDown}
      style={{
        width: 5,
        cursor: 'col-resize',
        background: 'transparent',
        position: 'relative',
        flexShrink: 0,
      }}
    >
      <div style={{
        position: 'absolute',
        left: 2,
        top: 0,
        bottom: 0,
        width: 1,
        background: 'var(--border)',
      }} />
    </div>
  )
}
