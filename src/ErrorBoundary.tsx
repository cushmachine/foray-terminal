import { Component, type ReactNode } from 'react'
import { MONO_FONT } from './theme'

interface Props {
  children: ReactNode
}

interface State {
  error: Error | null
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  render() {
    if (!this.state.error) return this.props.children

    return (
      <div style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        height: '100%',
        gap: 16,
        background: 'var(--bg)',
        color: 'var(--text)',
        fontFamily: MONO_FONT,
      }}>
        <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--danger)' }}>
          something went wrong
        </div>
        <div style={{
          fontSize: 12,
          color: 'var(--text-dim)',
          maxWidth: 400,
          textAlign: 'center',
          padding: '0 16px',
          wordBreak: 'break-word',
        }}>
          {this.state.error.message}
        </div>
        <button
          onClick={() => window.location.reload()}
          style={{
            background: 'var(--accent-dim)',
            border: '1px solid var(--accent)',
            color: 'var(--accent)',
            fontSize: 13,
            padding: '8px 20px',
            borderRadius: 6,
            cursor: 'pointer',
            fontFamily: MONO_FONT,
          }}
        >
          reload
        </button>
      </div>
    )
  }
}
