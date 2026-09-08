import type { FileNode } from '../shared/protocol'
import { MONO_FONT } from '../theme'

interface FileTreeProps {
  nodes: FileNode[]
  depth: number
  expanded: ReadonlySet<string>
  onToggleDir: (path: string) => void
  onSelect: (path: string) => void
  selectedPath: string | null
  isMobile: boolean
}

/** One level of the tree; recurses into expanded directories. Expansion lives in the store. */
export function FileTree({ nodes, depth, expanded, onToggleDir, onSelect, selectedPath, isMobile }: FileTreeProps) {
  return (
    <>
      {nodes.map(node => {
        const isDir = node.type === 'dir'
        const isOpen = isDir && expanded.has(node.path)
        const selected = node.path === selectedPath
        return (
          <div key={node.path}>
            <button
              onClick={() => (isDir ? onToggleDir(node.path) : onSelect(node.path))}
              aria-expanded={isDir ? isOpen : undefined}
              style={{
                width: '100%',
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                padding: isMobile ? '0 8px' : '5px 8px',
                minHeight: isMobile ? 44 : undefined,
                paddingLeft: 8 + depth * 16,
                background: selected ? 'var(--accent-dim)' : 'transparent',
                border: 'none',
                color: selected ? 'var(--accent)' :
                       isDir ? 'var(--text)' :
                       node.name.endsWith('.md') ? 'var(--accent-text)' : 'var(--text-dim)',
                fontSize: isMobile ? 13 : 12,
                fontFamily: MONO_FONT,
                cursor: 'pointer',
                textAlign: 'left',
                borderRadius: 3,
              }}
            >
              <span aria-hidden style={{ width: 14, textAlign: 'center', fontSize: 10, color: 'var(--text-faint)' }}>
                {isDir ? (isOpen ? '▼' : '▶') : ' '}
              </span>
              {node.name}
            </button>
            {isOpen && node.children && (
              <FileTree
                nodes={node.children}
                depth={depth + 1}
                expanded={expanded}
                onToggleDir={onToggleDir}
                onSelect={onSelect}
                selectedPath={selectedPath}
                isMobile={isMobile}
              />
            )}
          </div>
        )
      })}
    </>
  )
}
