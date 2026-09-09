// The "back to your last prompt" key. Claude Code echoes every prompt the
// user submits into the scrollback as a line starting with ❯, and a
// ❯-style shell prompt reads the same way, so those lines are where each
// exchange began. The key brings the latest one to the top of the viewport
// and, pressed again, the one before it, so a long answer on a small
// screen can be read from its start.

/** A line the user typed at: ❯ followed by text. The empty input box (❯ alone) is not one. */
export const PROMPT_LINE = /^\s*❯\s+\S/

/** Pixels of breathing room above the prompt line after a jump. */
export const PROMPT_JUMP_MARGIN_PX = 8

export function isPromptLine(text: string): boolean {
  return PROMPT_LINE.test(text)
}

/** Indices of the prompt lines in `lines`, in order. */
export function promptLineIndices(lines: readonly string[]): number[] {
  const out: number[] = []
  for (let i = 0; i < lines.length; i++) if (isPromptLine(lines[i])) out.push(i)
  return out
}

/**
 * The prompt to jump to next. `previous` is the line index the last jump
 * landed on, or null when there was none or the reader has scrolled since:
 * then the latest prompt. Otherwise the nearest one above the previous,
 * wrapping to the latest past the first so a press always goes somewhere.
 */
export function nextPromptIndex(prompts: readonly number[], previous: number | null): number | null {
  if (prompts.length === 0) return null
  const latest = prompts[prompts.length - 1]
  if (previous === null) return latest
  for (let k = prompts.length - 1; k >= 0; k--) if (prompts[k] < previous) return prompts[k]
  return latest
}
