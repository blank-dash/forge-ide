import { Component, type ErrorInfo, type ReactNode } from 'react'

type Props = {
  children: ReactNode
  /** Shown in the fallback so the user knows which part broke. */
  label: string
}

type State = {
  error: Error | null
}

/**
 * React still has no functional equivalent, so this stays a class component.
 * One boundary per pane means a crash in the chat transcript cannot take the
 * editor down with it.
 */
export default class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(`[${this.props.label}]`, error, info.componentStack)
  }

  private reset = (): void => this.setState({ error: null })

  override render(): ReactNode {
    const { error } = this.state
    if (!error) return this.props.children

    return (
      <div className="error-block" style={{ margin: 14 }}>
        <strong>{this.props.label} stopped responding.</strong>
        <div className="detail">{error.message}</div>
        <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
          <button className="btn" onClick={this.reset}>
            Try again
          </button>
          <button className="btn" onClick={() => window.location.reload()}>
            Reload the app
          </button>
        </div>
      </div>
    )
  }
}
