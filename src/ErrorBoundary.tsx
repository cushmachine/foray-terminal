import { Component, type ReactNode } from 'react'

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
          className="btn-outline tone-accent"
          onClick={() => window.location.reload()}
          style={{ fontSize: 13, padding: '8px 20px' }}
        >
          reload
        </button>
      </div>
    )
  }
}
