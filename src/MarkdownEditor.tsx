import { useEffect, useRef } from 'react'
import { EditorView, keymap, lineNumbers, highlightActiveLine, drawSelection, type KeyBinding } from '@codemirror/view'
import { EditorState } from '@codemirror/state'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { markdown } from '@codemirror/lang-markdown'
import { syntaxHighlighting, HighlightStyle } from '@codemirror/language'
import { tags } from '@lezer/highlight'

const theme = EditorView.theme({
  '&': {
    height: '100%',
    fontSize: '13px',
    background: '#0a0a0c',
  },
  '.cm-content': {
    fontFamily: "'JetBrains Mono', 'SF Mono', monospace",
    padding: '12px 0',
    caretColor: '#3db8a9',
    lineHeight: '1.7',
  },
  '.cm-line': {
    padding: '0 16px',
  },
  '.cm-gutters': {
    background: '#0a0a0c',
    border: 'none',
    color: '#3e3e4a',
  },
  '.cm-activeLineGutter': {
    background: '#111116',
    color: '#636370',
  },
  '.cm-activeLine': {
    background: '#111116',
  },
  '.cm-cursor': {
    borderColor: '#3db8a9',
  },
  '.cm-selectionBackground': {
    background: '#3db8a933 !important',
  },
  '&.cm-focused .cm-selectionBackground': {
    background: '#3db8a944 !important',
  },
  '.cm-scroller': {
    overflow: 'auto',
  },
}, { dark: true })

const highlights = HighlightStyle.define([
  { tag: tags.heading1, color: '#d4d4d8', fontWeight: '700', fontSize: '1.3em' },
  { tag: tags.heading2, color: '#3db8a9', fontWeight: '600', fontSize: '1.15em' },
  { tag: tags.heading3, color: '#5cd4c4', fontWeight: '600' },
  { tag: tags.emphasis, color: '#b07cd8', fontStyle: 'italic' },
  { tag: tags.strong, color: '#d4d4d8', fontWeight: '700' },
  { tag: tags.link, color: '#5e6ad2', textDecoration: 'underline' },
  { tag: tags.url, color: '#5e6ad2' },
  { tag: tags.monospace, color: '#e09a3c', background: '#1e1e26', borderRadius: '3px', padding: '1px 4px' },
  { tag: tags.list, color: '#636370' },
  { tag: tags.quote, color: '#636370', fontStyle: 'italic' },
  { tag: tags.processingInstruction, color: '#636370' },
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

interface MarkdownEditorProps {
  content: string
  onChange?: (content: string) => void
  onSave?: () => void
  readOnly?: boolean
}

export function MarkdownEditor({ content, onChange, onSave, readOnly }: MarkdownEditorProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange
  const onSaveRef = useRef(onSave)
  onSaveRef.current = onSave

  useEffect(() => {
    if (!containerRef.current) return

    const state = EditorState.create({
      doc: content,
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
    // Only recreate when switching between files or read-only mode
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [readOnly])

  return (
    <div ref={containerRef} style={{ height: '100%', width: '100%' }} />
  )
}
