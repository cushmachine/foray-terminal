// Mobile input bar.
//
// Typing straight into xterm on a phone is a bad fit: every character
// round-trips to the VM before it shows, and the soft keyboard composes
// and rewrites words through the IME, which the terminal app can't undo,
// so corrected words leave ghosts behind. Here the keyboard gets a real
// text field: it autocorrects and echoes locally, and the finished text
// reaches the terminal once, as a paste, followed by Enter. Tapping the
// terminal still types directly for quick y/n answers.
import { useCallback, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'

interface ComposerProps {
  /** Paste text into the active terminal and press Enter. Empty text just presses Enter. */
  onSubmit: (text: string) => void
}

/** Grow with the text up to about four lines, then scroll. */
const MAX_HEIGHT = 96

export function Composer({ onSubmit }: ComposerProps) {
  const [text, setText] = useState('')
  const ref = useRef<HTMLTextAreaElement>(null)

  const fit = useCallback(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT)}px`
  }, [])

  const submit = useCallback(() => {
    onSubmit(text.trim())
    setText('')
    // Keep the field focused so the keyboard stays up between messages.
    requestAnimationFrame(() => {
      const el = ref.current
      if (!el) return
      el.style.height = 'auto'
      el.focus()
    })
  }, [text, onSubmit])

  const handleKeyDown = (e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    // Enter sends; Shift+Enter (a hardware keyboard) inserts a newline.
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      submit()
    }
  }

  return (
    <div style={{
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
          setText(e.target.value)
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
      <button
        // Don't take focus from the field, or the keyboard drops on every tap.
        onPointerDown={(e) => e.preventDefault()}
        onClick={submit}
        aria-label={text ? 'Send' : 'Press Enter'}
        title={text ? 'Send' : 'Enter'}
        style={{
          flexShrink: 0,
          height: 36,
          minWidth: 44,
          padding: '0 12px',
          borderRadius: 10,
          border: '1px solid var(--accent-dim)',
          background: text ? 'var(--accent-dim)' : 'transparent',
          color: text ? 'var(--accent-text)' : 'var(--text-dim)',
          fontSize: 16,
          touchAction: 'manipulation',
        }}
      >
        ↵
      </button>
    </div>
  )
}
