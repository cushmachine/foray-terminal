import { useCallback, useState, lazy, Suspense, type ReactNode } from 'react'
import { MarkdownRenderer } from '../MarkdownRenderer'
import { useEscape } from '../hooks/useEscape'
import { clampFilePanelWidth } from '../mobile'
import { MONO_FONT } from '../theme'
import { FileTree } from './FileTree'
import { ResizeHandle } from './ResizeHandle'
import { useFileStore } from './useFileStore'

interface FilePanelProps {
  /** Whether the panel is showing. It stays mounted while hidden so the tree, expansion and watcher survive toggles. */
  open: boolean
  openFile: string | null
  onOpenFile: (path: string) => void
  /** Leave the open file and show the tree. */
  onCloseFile: () => void
  /** Hide the panel (desktop) or return to the terminal (phone). */
  onClosePanel: () => void
  isMobile: boolean
  width: number
  onResize: (width: number) => void
  /** Working directory to list/watch. Resolved server-side; files:read/write paths are relative to this. */
  cwd: string
}

// CodeMirror is a third of the bundle and only needed once a file is open.
// Loading it on demand keeps the first paint on a phone fast.
const MarkdownEditor = lazy(() =>
  import('../MarkdownEditor').then((m) => ({ default: m.MarkdownEditor })),
)

function Message({ children, tone = 'dim' }: { children: ReactNode; tone?: 'dim' | 'warning' }) {
  return (
    <div style={{
      padding: 16,
      fontSize: 12,
      color: tone === 'warning' ? 'var(--warning)' : 'var(--text-dim)',
      fontFamily: MONO_FONT,
    }}>
      {children}
    </div>
  )
}

const noticeButtonStyle = {
  background: 'transparent',
  color: 'var(--accent)',
  border: '1px solid var(--accent)',
  borderRadius: 4,
  padding: '3px 8px',
  fontFamily: MONO_FONT,
  fontSize: 11,
  cursor: 'pointer',
  flexShrink: 0,
} as const

/** A one-line strip between the header and the content: something happened on disk. */
function Notice({ children }: { children: ReactNode }) {
  return (
    <div role="status" style={{
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      padding: '6px 12px',
      borderBottom: '1px solid var(--border)',
      background: 'var(--surface-raised)',
      color: 'var(--warning)',
      fontFamily: MONO_FONT,
      fontSize: 11,
    }}>
      {children}
    </div>
  )
}

export function FilePanel({
  open,
  openFile,
  onOpenFile,
  onCloseFile,
  onClosePanel,
  isMobile,
  width,
  onResize,
  cwd,
}: FilePanelProps) {
  // Nothing is listed or watched until the panel is first shown; after
  // that it keeps its server-side state while hidden.
  const [everOpened, setEverOpened] = useState(open)
  if (open && !everOpened) setEverOpened(true)

  const files = useFileStore(cwd, openFile, everOpened)
  useEscape(onClosePanel, open)

  const fileContent = openFile !== null ? files.contents[openFile] : undefined
  const isFileLoading = openFile !== null && fileContent === undefined && !files.fileError
  const isMarkdown = openFile?.endsWith('.md') ?? false

  const handleResize = useCallback((delta: number) => {
    onResize(clampFilePanelWidth(width + delta))
  }, [width, onResize])

  const hit = isMobile ? 44 : undefined
  const headerButtonStyle = {
    background: 'none',
    border: 'none',
    color: 'var(--text-dim)',
    cursor: 'pointer',
    fontFamily: MONO_FONT,
    flexShrink: 0,
    minHeight: hit,
  } as const

  const closePanelButton = (
    <button
      onClick={onClosePanel}
      aria-label="Close panel"
      title={isMobile ? 'Back to terminal' : 'Close file panel'}
      style={{ ...headerButtonStyle, fontSize: 16, padding: '0 4px', minWidth: hit }}
    >
      ×
    </button>
  )

  const renderContent = () => {
    if (files.fileError) return <Message tone="warning">{files.fileError}</Message>
    if (files.editing) {
      return (
        <Suspense fallback={<Message>loading editor…</Message>}>
          <MarkdownEditor
            key={openFile}
            content={files.editContent}
            onChange={files.change}
            onSave={files.save}
          />
        </Suspense>
      )
    }
    if (files.removed) return <Message tone="warning">this file was deleted on disk</Message>
    if (isFileLoading) return <Message>loading…</Message>
    if (isMarkdown) {
      return (
        <div style={{ height: '100%', overflow: 'auto', padding: 16 }}>
          <MarkdownRenderer content={fileContent ?? ''} />
        </div>
      )
    }
    return (
      <Suspense fallback={<Message>loading editor…</Message>}>
        <MarkdownEditor key={openFile} content={fileContent ?? ''} readOnly />
      </Suspense>
    )
  }

  return (
    // On a phone the panel must take the viewport width, not its content's
    // max-content width: an unwrapped long line would otherwise widen the
    // whole column and push the header buttons off-screen.
    <div
      data-testid="file-panel"
      style={{
        display: open ? 'flex' : 'none',
        height: '100%',
        flexShrink: 0,
        width: isMobile ? '100%' : undefined,
        minWidth: 0,
      }}
    >
      {!isMobile && <ResizeHandle onResize={handleResize} />}
      <div style={{
        width: isMobile ? '100%' : width,
        height: '100%',
        background: 'var(--surface)',
        display: 'flex',
        flexDirection: 'column',
        flexShrink: 0,
      }}>
        {openFile !== null ? (
          <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
            {/* File header */}
            <div style={{
              display: 'flex',
              alignItems: 'center',
              padding: '8px 12px',
              borderBottom: '1px solid var(--border)',
              gap: 8,
              overflow: 'hidden',
              minWidth: 0,
            }}>
              <button
                onClick={onCloseFile}
                aria-label="Back to files"
                title="Back to the file tree"
                style={{ ...headerButtonStyle, fontSize: 12, padding: '2px 6px' }}
              >
                ← files
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
              {isMarkdown && (fileContent !== undefined || files.editing) && (
                <button
                  data-testid="file-edit-toggle"
                  onClick={() => (files.editing ? files.cancelEdit() : files.edit())}
                  aria-pressed={files.editing}
                  style={{
                    background: files.editing ? 'var(--accent-dim)' : 'transparent',
                    border: `1px solid ${files.editing ? 'var(--accent)' : 'var(--border)'}`,
                    color: files.editing ? 'var(--accent)' : 'var(--text-dim)',
                    fontSize: 11,
                    padding: isMobile ? '8px 12px' : '3px 8px',
                    borderRadius: 4,
                    cursor: 'pointer',
                    fontFamily: MONO_FONT,
                    flexShrink: 0,
                  }}
                >
                  {files.editing ? 'preview' : 'edit'}
                </button>
              )}
              {closePanelButton}
            </div>

            {files.diskChange && (
              <Notice>
                <span style={{ flex: 1 }}>changed on disk</span>
                <button onClick={files.reloadFromDisk} style={noticeButtonStyle}>reload</button>
                <button onClick={files.keepEdits} style={noticeButtonStyle}>keep mine</button>
              </Notice>
            )}
            {files.removed && files.editing && (
              <Notice>
                <span style={{ flex: 1 }}>deleted on disk; saving recreates it</span>
              </Notice>
            )}

            {/* Content */}
            <div style={{ flex: 1, minHeight: 0, overflow: 'hidden' }}>
              {renderContent()}
            </div>

            {/* Save bar */}
            {files.editing && (
              <div style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '8px 12px',
                borderTop: '1px solid var(--border)',
                justifyContent: 'flex-end',
              }}>
                {files.saveError && (
                  <span style={{
                    flex: 1,
                    fontSize: 11,
                    color: 'var(--warning)',
                    fontFamily: MONO_FONT,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}>
                    {files.saveError}
                  </span>
                )}
                <button
                  onClick={files.cancelEdit}
                  disabled={files.saving}
                  style={{
                    background: 'transparent',
                    border: '1px solid var(--border)',
                    color: 'var(--text-dim)',
                    padding: isMobile ? '10px 18px' : '6px 14px',
                    borderRadius: 4,
                    fontSize: 12,
                    cursor: files.saving ? 'default' : 'pointer',
                    opacity: files.saving ? 0.5 : 1,
                    fontFamily: MONO_FONT,
                  }}
                >
                  discard
                </button>
                <button
                  onClick={files.save}
                  disabled={files.saving}
                  style={{
                    background: 'var(--accent)',
                    border: 'none',
                    color: 'var(--bg)',
                    padding: isMobile ? '10px 18px' : '6px 14px',
                    borderRadius: 4,
                    fontSize: 12,
                    cursor: files.saving ? 'default' : 'pointer',
                    opacity: files.saving ? 0.7 : 1,
                    fontWeight: 600,
                    fontFamily: MONO_FONT,
                  }}
                >
                  {files.saving ? 'saving…' : 'save'}
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
                flex: 1,
                fontSize: 11,
                color: 'var(--text-dim)',
                fontFamily: MONO_FONT,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}>
                {cwd}
              </span>
              {closePanelButton}
            </div>
            <div style={{ flex: 1, overflow: 'auto', padding: '4px 4px' }}>
              {files.treeError ? (
                <Message tone="warning">{files.treeError}</Message>
              ) : files.tree === null ? (
                <Message>loading files…</Message>
              ) : (
                <>
                  <FileTree
                    nodes={files.tree}
                    depth={0}
                    expanded={files.expanded}
                    onToggleDir={files.toggleDir}
                    onSelect={onOpenFile}
                    selectedPath={openFile}
                    isMobile={isMobile}
                  />
                  {files.truncated && (
                    <Message>listing truncated: too many files to show them all</Message>
                  )}
                </>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
