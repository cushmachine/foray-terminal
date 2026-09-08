import type { FileNode } from '../shared/protocol'

interface FileTreeProps {
  nodes: FileNode[]
  depth: number
  expanded: ReadonlySet<string>
  onToggleDir: (path: string) => void
  onSelect: (path: string) => void
  selectedPath: string | null
  isMobile: boolean
}

/** What a row is, for its colour (styles.css .tree-item). */
function kindOf(node: FileNode): 'dir' | 'md' | 'file' {
  if (node.type === 'dir') return 'dir'
  return node.name.endsWith('.md') ? 'md' : 'file'
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
              className="btn-ghost tree-item"
              data-kind={kindOf(node)}
              onClick={() => (isDir ? onToggleDir(node.path) : onSelect(node.path))}
              aria-expanded={isDir ? isOpen : undefined}
              aria-current={selected ? 'true' : undefined}
              style={{
                width: '100%',
                justifyContent: 'flex-start',
                padding: isMobile ? '0 8px' : '5px 8px',
                minHeight: isMobile ? 'var(--hit)' : undefined,
                paddingLeft: 8 + depth * 16,
                fontSize: isMobile ? 13 : 12,
                textAlign: 'left',
                borderRadius: 'var(--radius-sm)',
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
