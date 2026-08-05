import { useEffect, useRef } from 'react'
import { useStore } from '../store'

interface Props {
  onClose(): void
}

export default function ModelPicker({ onClose }: Props): JSX.Element {
  const selected = useStore((state) => state.sessionModel)
  const settings = useStore((state) => state.settings)
  const patchUi = useStore((state) => state.patchUi)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onPointerDown = (event: MouseEvent): void => {
      if (!ref.current?.contains(event.target as Node)) onClose()
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  const select = async (ref_: string): Promise<void> => {
    const next = await window.forge.agent.model(ref_, useStore.getState().sessionId ?? undefined)
    useStore.getState().setSessionModel(next)
    onClose()
  }

  const usable = settings.providers.filter((provider) => provider.enabled)

  return (
    <div className="popover" ref={ref}>
      {usable.length === 0 && (
        <div className="popover-group">No providers enabled — open Settings → Providers.</div>
      )}

      {usable.map((provider) => (
        <div key={provider.id}>
          <div className="popover-group">
            {provider.name}
            {!provider.apiKey && ' · no API key'}
          </div>
          {provider.models.length === 0 && (
            <div className="popover-item" style={{ color: 'var(--fg-3)' }}>
              No models configured
            </div>
          )}
          {provider.models.map((model) => {
            const value = `${provider.id}:${model.id}`
            const active = (selected || settings.activeModel) === value
            return (
              <button
                key={value}
                className={`popover-item ${active ? 'active' : ''}`}
                onClick={() => void select(value)}
              >
                <span className="check">{active ? '✓' : ''}</span>
                <span>{model.label || model.id}</span>
                <span className="sub">{formatContext(model.contextWindow)}</span>
              </button>
            )
          })}
        </div>
      ))}

      <div style={{ borderTop: '1px solid var(--border)', marginTop: 4, paddingTop: 4 }}>
        <button
          className="popover-item"
          onClick={() => {
            patchUi({ settingsOpen: true, settingsSection: 'providers' })
            onClose()
          }}
        >
          <span className="check">+</span>
          <span>Add or edit providers…</span>
        </button>
      </div>
    </div>
  )
}

function formatContext(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(0)}M`
  return `${Math.round(tokens / 1000)}K`
}
