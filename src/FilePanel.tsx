import { useState, useCallback, useRef, useEffect, lazy, Suspense } from 'react'
import type { ClientMessage, ServerMessage, FileNode } from './shared/protocol'
import type { SocketStatus } from './hooks/useSocket'
import { MarkdownRenderer } from './MarkdownRenderer'
import { MONO_FONT } from './theme'

interface FilePanelProps {
  openFile: string | null
  onOpenFile: (path: string) => void
  onClose: () => void
  isMobile: boolean
  width: number
  onResize: (width: number) => void
  /** Working directory to list/watch. Resolved server-side; files:read/write paths are relative to this. */
  cwd: string
  /** Send a protocol message to the server over the shared WebSocket. */
  send: (msg: ClientMessage) => void
  /** Subscribe to incoming protocol messages. Returns an unsubscribe function. */
  onMessage: (handler: (msg: ServerMessage) => void) => () => void
  /**
   * Connection status. The server forgets this connection's cwd and file
   * watcher when the socket closes, so the panel re-establishes both on
   * every reconnect.
   */
  status: SocketStatus
}

// CodeMirror is a third of the bundle and only needed once a file is open.
// Loading it on demand keeps the first paint on a phone fast.
const MarkdownEditor = lazy(() =>
  import('./MarkdownEditor').then((m) => ({ default: m.MarkdownEditor })),
)

function EditorFallback() {
  return (
    <div style={{
      padding: 16,
      fontSize: 12,
      color: 'var(--text-dim)',
      fontFamily: MONO_FONT,
    }}>
      loading editor…
    </div>
  )
}

function FileTree({ nodes, depth, onSelect, selectedPath, isMobile }: {
  nodes: FileNode[]
  depth: number
  onSelect: (path: string) => void
  selectedPath: string | null
  isMobile: boolean
}) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  return (
    <>
      {nodes.map(node => (
        <div key={node.path}>
          <button
            onClick={() => {
              if (node.type === 'dir') {
                setExpanded(prev => {
                  const next = new Set(prev)
                  next.has(node.path) ? next.delete(node.path) : next.add(node.path)
                  return next
                })
              } else {
                onSelect(node.path)
              }
            }}
            style={{
              width: '100%',
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              padding: isMobile ? '0 8px' : '5px 8px',
              minHeight: isMobile ? 44 : undefined,
              paddingLeft: 8 + depth * 16,
              background: node.path === selectedPath ? 'var(--accent-dim)' : 'transparent',
              border: 'none',
              color: node.path === selectedPath ? 'var(--accent)' :
                     node.type === 'dir' ? 'var(--text)' :
                     node.name.endsWith('.md') ? 'var(--accent-text)' : 'var(--text-dim)',
              fontSize: isMobile ? 13 : 12,
              fontFamily: MONO_FONT,
              cursor: 'pointer',
              textAlign: 'left',
              borderRadius: 3,
            }}
          >
            <span style={{ width: 14, textAlign: 'center', fontSize: 10, color: 'var(--text-faint)' }}>
              {node.type === 'dir' ? (expanded.has(node.path) ? '▼' : '▶') : ' '}
            </span>
            {node.name}
          </button>
          {node.type === 'dir' && expanded.has(node.path) && node.children && (
            <FileTree
              nodes={node.children}
              depth={depth + 1}
              onSelect={onSelect}
              selectedPath={selectedPath}
              isMobile={isMobile}
            />
          )}
        </div>
      ))}
    </>
  )
}

function ResizeHandle({ onResize }: { onResize: (delta: number) => void }) {
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

  const handlePointerUp = useCallback(() => {
    dragging.current = false
  }, [])

  const handlePointerCancel = useCallback(() => {
    dragging.current = false
  }, [])

  return (
    <div
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerCancel}
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

export function FilePanel({ openFile, onOpenFile, onClose, isMobile, width, onResize, cwd, send, onMessage, status }: FilePanelProps) {
  const [tree, setTree] = useState<FileNode[] | null>(null)
  const [treeError, setTreeError] = useState<string | null>(null)
  const [fileContents, setFileContents] = useState<Record<string, string>>({})
  const [loadingPath, setLoadingPath] = useState<string | null>(null)
  const [fileError, setFileError] = useState<string | null>(null)
  const [editing, setEditing] = useState(false)
  const [editContent, setEditContent] = useState('')
  const [saving, setSaving] = useState(false)

  // `send` may not be referentially stable across parent re-renders; keep a
  // ref so effects below don't need to depend on (and re-run for) it.
  const sendRef = useRef(send)
  sendRef.current = send

  const openFileRef = useRef(openFile)
  openFileRef.current = openFile

  const loadingPathRef = useRef(loadingPath)
  loadingPathRef.current = loadingPath

  // Subscribe once to the shared socket's incoming messages and route the
  // file-related ones into local state.
  useEffect(() => {
    return onMessage((msg) => {
      switch (msg.type) {
        case 'files:tree':
          setTree(msg.entries)
          setTreeError(null)
          break
        case 'files:content':
          setFileContents(prev => ({ ...prev, [msg.path]: msg.content }))
          setLoadingPath(prev => (prev === msg.path ? null : prev))
          setFileError(null)
          break
        case 'files:changed':
          // Update the cached content for any watched file, whether or not
          // it's currently open — keeps things fresh if the user reopens it.
          setFileContents(prev => ({ ...prev, [msg.path]: msg.content }))
          break
        case 'files:saved':
          setSaving(false)
          setEditing(false)
          break
        case 'error':
          if (loadingPathRef.current) {
            setFileError(msg.message)
          } else {
            setTreeError(msg.message)
          }
          setLoadingPath(null)
          setSaving(false)
          break
        default:
          break
      }
    })
  }, [onMessage])

  // Request the tree and start watching whenever the panel mounts, the
  // target directory changes, or the socket comes back after a drop (the
  // server's per-connection cwd and watcher died with the old socket).
  // Only re-run for the connected state so a disconnect doesn't wipe the
  // tree the user is looking at.
  const connected = status === 'connected'
  useEffect(() => {
    if (!connected) return
    setTree(null)
    setTreeError(null)
    setFileContents({})
    sendRef.current({ type: 'files:tree', cwd })
    sendRef.current({ type: 'files:watch', cwd })
    // Re-fetch the currently open file after reconnect
    const currentFile = openFileRef.current
    if (currentFile) {
      setLoadingPath(currentFile)
      sendRef.current({ type: 'files:read', path: currentFile })
    }
    return () => {
      sendRef.current({ type: 'files:unwatch' })
    }
  }, [cwd, connected])

  // Fetch content whenever a not-yet-cached file is selected.
  useEffect(() => {
    if (!openFile || fileContents[openFile] !== undefined) return
    setLoadingPath(openFile)
    setFileError(null)
    sendRef.current({ type: 'files:read', path: openFile })
    // fileContents is intentionally excluded: it's only read here to decide
    // whether a fetch is needed, not to trigger one. Depending on it would
    // cause this to re-run (and loop) every time files:content/files:changed
    // update the cache.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openFile])

  const fileContent = openFile ? fileContents[openFile] : undefined
  const isFileLoading = openFile !== null && fileContent === undefined && !fileError
  const isMarkdown = openFile?.endsWith('.md') ?? false

  const handleEdit = useCallback(() => {
    if (fileContent !== undefined) setEditContent(fileContent)
    setEditing(true)
  }, [fileContent])

  const handleSave = useCallback(() => {
    if (!openFile) return
    const content = editContent
    setSaving(true)
    // Optimistically cache the saved content so it's ready immediately;
    // the eventual files:changed echo from our own watcher will confirm it.
    setFileContents(prev => ({ ...prev, [openFile]: content }))
    sendRef.current({ type: 'files:write', path: openFile, content })
  }, [openFile, editContent])

  const handleResize = useCallback((delta: number) => {
    onResize(Math.max(200, Math.min(800, width + delta)))
  }, [width, onResize])

  const closePanel = useCallback(() => {
    onClose()
    setEditing(false)
  }, [onClose])

  return (
    <div data-testid="file-panel" style={{ display: 'flex', height: '100%', flexShrink: 0 }}>
      {!isMobile && <ResizeHandle onResize={handleResize} />}
      <div style={{
        width: isMobile ? '100%' : width,
        height: '100%',
        background: 'var(--surface)',
        display: 'flex',
        flexDirection: 'column',
        flexShrink: 0,
      }}>
        {openFile ? (
          <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
            {/* File header */}
            <div style={{
              display: 'flex',
              alignItems: 'center',
              padding: '8px 12px',
              borderBottom: '1px solid var(--border)',
              gap: 8,
            }}>
              <button
                onClick={closePanel}
                style={{
                  background: 'none',
                  border: 'none',
                  color: 'var(--text-dim)',
                  fontSize: 12,
                  cursor: 'pointer',
                  fontFamily: MONO_FONT,
                  padding: '2px 6px',
                  minHeight: isMobile ? 44 : undefined,
                }}
              >
                ← tree
              </button>
              <span style={{
                flex: 1,
                fontSize: 12,
                fontFamily: MONO_FONT,
                color: 'var(--accent-text)',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}>
                {openFile}
              </span>
              {isMarkdown && fileContent !== undefined && (
                <button
                  onClick={() => editing ? setEditing(false) : handleEdit()}
                  style={{
                    background: editing ? 'var(--accent-dim)' : 'transparent',
                    border: `1px solid ${editing ? 'var(--accent)' : 'var(--border)'}`,
                    color: editing ? 'var(--accent)' : 'var(--text-dim)',
                    fontSize: 11,
                    padding: isMobile ? '8px 12px' : '3px 8px',
                    borderRadius: 4,
                    cursor: 'pointer',
                    fontFamily: MONO_FONT,
                  }}
                >
                  {editing ? 'preview' : 'edit'}
                </button>
              )}
              <button
                onClick={closePanel}
                aria-label="Close file"
                style={{
                  background: 'none',
                  border: 'none',
                  color: 'var(--text-dim)',
                  fontSize: 16,
                  cursor: 'pointer',
                  padding: '0 4px',
                  minWidth: isMobile ? 44 : undefined,
                  minHeight: isMobile ? 44 : undefined,
                }}
              >
                ×
              </button>
            </div>

            {/* Content */}
            <div style={{ flex: 1, minHeight: 0, overflow: 'hidden' }}>
              {fileError ? (
                <div style={{
                  padding: 16,
                  fontSize: 12,
                  color: 'var(--warning)',
                  fontFamily: MONO_FONT,
                }}>
                  {fileError}
                </div>
              ) : isFileLoading ? (
                <div style={{
                  padding: 16,
                  fontSize: 12,
                  color: 'var(--text-dim)',
                  fontFamily: MONO_FONT,
                }}>
                  loading…
                </div>
              ) : editing ? (
                <Suspense fallback={<EditorFallback />}>
                  <MarkdownEditor
                    content={editing ? editContent : (fileContent ?? '')}
                    onChange={setEditContent}
                    onSave={handleSave}
                  />
                </Suspense>
              ) : isMarkdown ? (
                <div style={{ height: '100%', overflow: 'auto', padding: 16 }}>
                  <MarkdownRenderer content={fileContent ?? ''} />
                </div>
              ) : (
                <Suspense fallback={<EditorFallback />}>
                  <MarkdownEditor content={fileContent ?? ''} readOnly />
                </Suspense>
              )}
            </div>

            {/* Save bar */}
            {editing && (
              <div style={{
                display: 'flex',
                gap: 8,
                padding: '8px 12px',
                borderTop: '1px solid var(--border)',
                justifyContent: 'flex-end',
              }}>
                <button
                  onClick={() => { setEditing(false); setEditContent('') }}
                  disabled={saving}
                  style={{
                    background: 'transparent',
                    border: '1px solid var(--border)',
                    color: 'var(--text-dim)',
                    padding: isMobile ? '10px 18px' : '6px 14px',
                    borderRadius: 4,
                    fontSize: 12,
                    cursor: saving ? 'default' : 'pointer',
                    opacity: saving ? 0.5 : 1,
                    fontFamily: MONO_FONT,
                  }}
                >
                  discard
                </button>
                <button
                  onClick={handleSave}
                  disabled={saving}
                  style={{
                    background: 'var(--accent)',
                    border: 'none',
                    color: 'var(--bg)',
                    padding: isMobile ? '10px 18px' : '6px 14px',
                    borderRadius: 4,
                    fontSize: 12,
                    cursor: saving ? 'default' : 'pointer',
                    opacity: saving ? 0.7 : 1,
                    fontWeight: 600,
                    fontFamily: MONO_FONT,
                  }}
                >
                  {saving ? 'saving…' : 'save'}
                </button>
              </div>
            )}
          </div>
        ) : (
          <>
            <div style={{
              padding: '10px 12px',
              borderBottom: '1px solid var(--border-subtle)',
              display: 'flex',
              alignItems: 'center',
              gap: 8,
            }}>
              <span style={{
                fontSize: 11,
                fontWeight: 600,
                textTransform: 'uppercase',
                letterSpacing: '0.08em',
                color: 'var(--text-faint)',
              }}>
                Files
              </span>
              <span style={{
                fontSize: 11,
                color: 'var(--text-dim)',
                fontFamily: MONO_FONT,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}>
                {cwd}
              </span>
            </div>
            <div style={{ flex: 1, overflow: 'auto', padding: '4px 4px' }}>
              {treeError ? (
                <div style={{
                  padding: 16,
                  fontSize: 12,
                  color: 'var(--warning)',
                  fontFamily: MONO_FONT,
                }}>
                  {treeError}
                </div>
              ) : tree === null ? (
                <div style={{
                  padding: 16,
                  fontSize: 12,
                  color: 'var(--text-dim)',
                  fontFamily: MONO_FONT,
                }}>
                  loading files…
                </div>
              ) : (
                <FileTree
                  nodes={tree}
                  depth={0}
                  onSelect={onOpenFile}
                  selectedPath={openFile}
                  isMobile={isMobile}
                />
              )}
            </div>
          </>
        )}
      </div>
    </div>
  )
}

