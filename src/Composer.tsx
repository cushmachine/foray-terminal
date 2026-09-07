// Mobile input bar.
//
// Typing straight into xterm on a phone is a bad fit: every character
// round-trips to the VM before it shows, and the soft keyboard composes
// and rewrites words through the IME, which the terminal app can't undo,
// so corrected words leave ghosts behind. Here the keyboard gets a real
// text field: it autocorrects and echoes locally, and the finished text
// reaches the terminal once, as a paste, followed by Enter. Tapping the
// terminal still types directly for quick y/n answers.
//
// The unsent text is saved per session (draftKey) so switching sessions —
// or backgrounding the app — never loses what you were typing.
import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'

interface ComposerProps {
  /** Paste text into the active terminal and press Enter. Empty text just presses Enter. */
  onSubmit: (text: string) => void
  /** localStorage key for this session's unsent draft; null when no session is active. */
  draftKey?: string | null
}

/** Grow with the text up to about four lines, then scroll. */
const MAX_HEIGHT = 96

// localStorage throws in some private-browsing and embedded contexts; a lost
// draft is not worth crashing the input bar over, so treat it as absent.
function draftGet(key: string | null | undefined): string {
  if (!key) return ''
  try {
    return window.localStorage.getItem(key) ?? ''
  } catch {
    return ''
  }
}

function draftSet(key: string | null | undefined, value: string): void {
  if (!key) return
  try {
    if (value) window.localStorage.setItem(key, value)
    else window.localStorage.removeItem(key)
  } catch {
    // The draft just won't persist.
  }
}

export function Composer({ onSubmit, draftKey = null }: ComposerProps) {
  const [text, setText] = useState(() => draftGet(draftKey))
  const ref = useRef<HTMLTextAreaElement>(null)
  // The draftKey this component last saved under, so a session switch can
  // stash the old draft before loading the new one.
  const prevKeyRef = useRef(draftKey)

  const fit = useCallback(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT)}px`
  }, [])

  // Size the field to any draft restored on first mount.
  useEffect(() => {
    fit()
  }, [fit])

  // Session switch: save the current draft under the old key, load the new.
  useEffect(() => {
    if (prevKeyRef.current === draftKey) return
    draftSet(prevKeyRef.current, text)
    prevKeyRef.current = draftKey
    setText(draftGet(draftKey))
    requestAnimationFrame(fit)
  }, [draftKey, text, fit])

  const submit = useCallback(() => {
    onSubmit(text.trim())
    setText('')
    draftSet(draftKey, '')
    // Keep the field focused so the keyboard stays up between messages.
    requestAnimationFrame(() => {
      const el = ref.current
      if (!el) return
      el.style.height = 'auto'
      el.focus()
    })
  }, [text, onSubmit, draftKey])

  const handleKeyDown = (e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    // Enter sends; Shift+Enter (a hardware keyboard) inserts a newline.
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      submit()
    }
  }

  return (
    <div data-composer style={{
      display: 'flex',
      alignItems: 'flex-end',
      gap: 6,
      padding: '6px 8px 0',
      background: 'var(--surface)',
      borderTop: '1px solid var(--border)',
      flexShrink: 0,
    }}>
      <textarea
        ref={ref}
        value={text}
        onChange={(e) => {
          const value = e.target.value
          setText(value)
          draftSet(draftKey, value)
          fit()
        }}
        onKeyDown={handleKeyDown}
        rows={1}
        placeholder="Message"
        enterKeyHint="send"
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck
        aria-label="Message to send to the terminal"
        style={{
          flex: 1,
          minWidth: 0,
          resize: 'none',
          // 16px or larger, or iOS zooms the page on focus.
          fontSize: 16,
          lineHeight: 1.35,
          padding: '7px 10px',
          borderRadius: 10,
          border: '1px solid var(--border)',
          background: 'var(--bg)',
          color: 'var(--text)',
          outline: 'none',
          fontFamily: 'inherit',
          maxHeight: MAX_HEIGHT,
          overflowY: 'auto',
        }}
      />
    </div>
  )
}
