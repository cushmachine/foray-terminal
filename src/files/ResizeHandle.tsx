import { useCallback, useRef } from 'react'

/** The drag strip on the file panel's left edge; reports horizontal movement as a width delta. */
export function ResizeHandle({ onResize }: { onResize: (delta: number) => void }) {
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

  return (
    <div
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={stopDragging}
      onPointerCancel={stopDragging}
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
