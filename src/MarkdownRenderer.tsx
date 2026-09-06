import { MONO_FONT } from './theme'

export function MarkdownRenderer({ content }: { content: string }) {
  return (
    <div style={{
      fontSize: 13,
      lineHeight: 1.7,
      fontFamily: MONO_FONT,
      color: 'var(--text)',
    }}>
      {content.split('\n').map((line, i) => {
        if (line.startsWith('# ')) return (
          <div key={i} style={{ fontSize: 18, fontWeight: 700, color: 'var(--text)', marginBottom: 12, marginTop: i > 0 ? 20 : 0 }}>
            {line.slice(2)}
          </div>
        )
        if (line.startsWith('## ')) return (
          <div key={i} style={{ fontSize: 15, fontWeight: 600, color: 'var(--accent)', marginBottom: 8, marginTop: 16 }}>
            {line.slice(3)}
          </div>
        )
        if (line.startsWith('- [x] ')) return (
          <div key={i} style={{ paddingLeft: 8, marginBottom: 4 }}>
            <span style={{ color: 'var(--accent)', marginRight: 8 }}>&#10003;</span>
            <span style={{ textDecoration: 'line-through', color: 'var(--text-dim)' }}>{line.slice(6)}</span>
          </div>
        )
        if (line.startsWith('- [ ] ')) return (
          <div key={i} style={{ paddingLeft: 8, marginBottom: 4 }}>
            <span style={{ color: 'var(--text-faint)', marginRight: 8 }}>&#9675;</span>
            {line.slice(6)}
          </div>
        )
        if (line.startsWith('- ')) return (
          <div key={i} style={{ paddingLeft: 8, marginBottom: 4 }}>
            <span style={{ color: 'var(--text-faint)', marginRight: 8 }}>&middot;</span>
            {renderInline(line.slice(2))}
          </div>
        )
        if (line.trim() === '') return <div key={i} style={{ height: 8 }} />
        return <div key={i} style={{ marginBottom: 4 }}>{renderInline(line)}</div>
      })}
    </div>
  )
}

function renderInline(text: string) {
  const parts = text.split(/(`[^`]+`)/)
  return parts.map((part, i) => {
    if (part.startsWith('`') && part.endsWith('`')) {
      return (
        <code key={i} style={{
          background: 'var(--surface-raised)',
          color: 'var(--warning)',
          padding: '1px 5px',
          borderRadius: 3,
          fontSize: '0.9em',
        }}>
          {part.slice(1, -1)}
        </code>
      )
    }
    return part
  })
}
