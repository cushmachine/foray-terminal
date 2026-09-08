import { useEffect, useRef } from 'react'
import { EditorView, keymap, lineNumbers, highlightActiveLine, drawSelection, type KeyBinding } from '@codemirror/view'
import { EditorState } from '@codemirror/state'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { markdown } from '@codemirror/lang-markdown'
import { syntaxHighlighting, HighlightStyle } from '@codemirror/language'
import { tags } from '@lezer/highlight'

// Colours come from styles.css; CodeMirror writes these as a stylesheet,
// so var() resolves the same way it does for the rest of the page.
const theme = EditorView.theme({
  '&': {
    height: '100%',
    fontSize: '13px',
    background: 'var(--bg)',
  },
  '.cm-scroller': {
    fontFamily: 'var(--font-mono)',
    overflow: 'auto',
  },
  '.cm-content': {
    padding: '12px 0',
    caretColor: 'var(--term-cursor)',
    lineHeight: '1.7',
  },
  '.cm-line': {
    padding: '0 16px',
  },
  '.cm-gutters': {
    background: 'var(--bg)',
    border: 'none',
    color: 'var(--text-faint)',
  },
  '.cm-activeLineGutter': {
    background: 'var(--surface)',
    color: 'var(--text-dim)',
  },
  '.cm-activeLine': {
    background: 'var(--surface)',
  },
  '.cm-cursor': {
    borderColor: 'var(--term-cursor)',
  },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': {
    background: 'var(--term-selection) !important',
  },
}, { dark: true })

const highlights = HighlightStyle.define([
  { tag: tags.heading1, color: 'var(--text)', fontWeight: '700', fontSize: '1.3em' },
  { tag: tags.heading2, color: 'var(--accent)', fontWeight: '600', fontSize: '1.15em' },
  { tag: tags.heading3, color: 'var(--accent-text)', fontWeight: '600' },
  { tag: tags.emphasis, color: 'var(--ansi-magenta)', fontStyle: 'italic' },
  { tag: tags.strong, color: 'var(--text)', fontWeight: '700' },
  { tag: tags.link, color: 'var(--ansi-blue)', textDecoration: 'underline' },
  { tag: tags.url, color: 'var(--ansi-blue)' },
  { tag: tags.monospace, color: 'var(--warning)', background: 'var(--surface-hover)', borderRadius: 'var(--radius-sm)', padding: '1px 4px' },
  { tag: tags.list, color: 'var(--text-dim)' },
  { tag: tags.quote, color: 'var(--text-dim)', fontStyle: 'italic' },
  { tag: tags.processingInstruction, color: 'var(--text-dim)' },
])

/**
 * Builds the Cmd+S (Mac) / Ctrl+S (Windows/Linux) key binding that triggers
 * `onSave`. CodeMirror's "Mod-" prefix maps to Cmd on Mac and Ctrl elsewhere,
 * so a single binding covers both platforms.
 *
 * Extracted as a standalone function (rather than inlined in the effect
 * below) so the save behavior can be unit-tested without a DOM/EditorView —
 * `run` never touches its `view` argument.
 */
export function createSaveKeymap(onSave: (() => void) | undefined): KeyBinding[] {
  return [
    {
      key: 'Mod-s',
      run: () => {
        onSave?.()
        return true
      },
    },
  ]
}

/**
 * The change that turns the editor's document into `next`, or null when
 * they already agree. Applied when content arrives from outside (a reload
 * from disk); the parent echoing back what was just typed is a no-op, so
 * the view is never rebuilt or disturbed by a keystroke.
 */
export function docReplacement(current: string, next: string): { from: number; to: number; insert: string } | null {
  if (current === next) return null
  return { from: 0, to: current.length, insert: next }
}

interface MarkdownEditorProps {
  content: string
  onChange?: (content: string) => void
  onSave?: () => void
  readOnly?: boolean
}

/**
 * One CodeMirror view per mounted editor. The parent keys the component on
 * the file path, so switching files remounts; content changes on the same
 * file are dispatched into the live view instead.
 */
export function MarkdownEditor({ content, onChange, onSave, readOnly }: MarkdownEditorProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const contentRef = useRef(content)
  contentRef.current = content
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange
  const onSaveRef = useRef(onSave)
  onSaveRef.current = onSave

  useEffect(() => {
    if (!containerRef.current) return

    const state = EditorState.create({
      doc: contentRef.current,
      extensions: [
        theme,
        syntaxHighlighting(highlights),
        markdown(),
        history(),
        drawSelection(),
        highlightActiveLine(),
        lineNumbers(),
        keymap.of([
          ...createSaveKeymap(() => onSaveRef.current?.()),
          ...defaultKeymap,
          ...historyKeymap,
          indentWithTab,
        ]),
        EditorView.lineWrapping,
        ...(readOnly ? [EditorState.readOnly.of(true)] : []),
        EditorView.updateListener.of(update => {
          if (update.docChanged && onChangeRef.current) {
            onChangeRef.current(update.state.doc.toString())
          }
        }),
      ],
    })

    const view = new EditorView({ state, parent: containerRef.current })
    viewRef.current = view

    return () => {
      view.destroy()
      viewRef.current = null
    }
  }, [readOnly])

  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    const changes = docReplacement(view.state.doc.toString(), content)
    if (changes) view.dispatch({ changes })
  }, [content])

  return (
    <div ref={containerRef} style={{ height: '100%', width: '100%' }} />
  )
}
