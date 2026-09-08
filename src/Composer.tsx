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
// or backgrounding the app — never loses what you were typing. App mounts
// one Composer per draftKey (`key={draftKey}`), so a session switch is an
// unmount and a fresh mount: the draft is saved on the way out and read
// on the way in.
import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { storageGet, storageRemove, storageSet } from './storage'

interface ComposerProps {
  /** Paste text into the active terminal and press Enter. Empty text just presses Enter. */
  onSubmit: (text: string) => void
  /** localStorage key for this session's unsent draft; null when no session is active. */
  draftKey?: string | null
}

/** Grow with the text up to about four lines, then scroll. */
const MAX_HEIGHT = 96

function readDraft(key: string | null): string {
  return key ? storageGet(key) ?? '' : ''
}

function saveDraft(key: string | null, value: string): void {
  if (!key) return
  if (value) storageSet(key, value)
  else storageRemove(key)
}

export function Composer({ onSubmit, draftKey = null }: ComposerProps) {
  const [text, setText] = useState(() => readDraft(draftKey))
  const ref = useRef<HTMLTextAreaElement>(null)
  const textRef = useRef(text)
  textRef.current = text

  const fit = useCallback(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT)}px`
  }, [])

  // Size the field to any draft restored on mount.
  useEffect(() => {
    fit()
  }, [fit])

  // Save on unmount (a session switch remounts under a new key). Every
  // change is also saved as it happens because a backgrounded PWA can be
  // killed by the OS without ever unmounting.
  useEffect(() => {
    return () => saveDraft(draftKey, textRef.current)
  }, [draftKey])

  const submit = useCallback(() => {
    onSubmit(text.trim())
    setText('')
    saveDraft(draftKey, '')
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
          saveDraft(draftKey, value)
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
