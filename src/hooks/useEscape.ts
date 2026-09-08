// Escape closes the topmost open panel or drawer.
//
// Every open panel registers a handler; one window listener runs the most
// recently registered, so a drawer opened over the file panel closes
// first. Escape typed into anything editable is left alone: the terminal
// (vim, Claude Code's interrupt), the composer, the markdown editor and
// the rename field all have their own meaning for it.

import { useEffect, useRef } from 'react'

/** The bits of an event target the editable check needs; a real Element satisfies it. */
export interface EditableProbe {
  tagName?: string
  isContentEditable?: boolean
}

export function isEditableTarget(target: EditableProbe | null | undefined): boolean {
  if (!target) return false
  const tag = target.tagName?.toUpperCase()
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable === true
}

type HandlerRef = { current: () => void }

const stack: HandlerRef[] = []

function onKeyDown(e: KeyboardEvent): void {
  if (e.key !== 'Escape' || e.defaultPrevented) return
  if (isEditableTarget(e.target as Element | null)) return
  const top = stack[stack.length - 1]
  if (!top) return
  e.preventDefault()
  top.current()
}

export function useEscape(handler: () => void, enabled: boolean): void {
  const ref = useRef(handler)
  ref.current = handler
  useEffect(() => {
    if (!enabled) return
    if (stack.length === 0) window.addEventListener('keydown', onKeyDown)
    stack.push(ref)
    return () => {
      const at = stack.indexOf(ref)
      if (at >= 0) stack.splice(at, 1)
      if (stack.length === 0) window.removeEventListener('keydown', onKeyDown)
    }
  }, [enabled])
}
