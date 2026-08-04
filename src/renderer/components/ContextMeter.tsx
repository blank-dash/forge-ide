import { useStore } from '../store'

/**
 * How full the model's context window is.
 *
 * Before the first reply this is Forge's own estimate; afterwards it is the
 * provider's reported input count, which is the real number. The distinction
 * matters enough to surface — an estimate that says 60% can be wrong by a
 * wide margin on a conversation full of code.
 */
export default function ContextMeter() {
  const context = useStore((state) => state.context)
  const settings = useStore((state) => state.settings)
  const patchUi = useStore((state) => state.patchUi)

  const window = context?.window ?? activeContextWindow(settings)
  if (!window) return null

  const used = context?.used ?? 0
  const ratio = Math.min(1, used / window)
  const percent = Math.round(ratio * 100)
  const level = ratio >= 0.9 ? 'danger' : ratio >= 0.7 ? 'warn' : ''

  return (
    <button
      className={`ctx-meter ${level}`}
      onClick={() => patchUi({ settingsOpen: true, settingsSection: 'providers' })}
      title={
        `${used.toLocaleString()} of ${window.toLocaleString()} tokens (${percent}%).\n` +
        (context
          ? context.estimated
            ? 'Estimated — the provider has not reported usage for this conversation yet.'
            : 'Reported by the provider for the last request.'
          : 'Nothing sent yet.') +
        '\n\nClick to change the context window for this model.'
      }
    >
      <span className="ctx-bar">
        <span className="ctx-fill" style={{ width: `${Math.max(percent, 2)}%` }} />
      </span>
      <span className="ctx-text">
        {context?.estimated ? '~' : ''}
        {compact(used)}/{compact(window)}
      </span>
    </button>
  )
}

function activeContextWindow(settings: ReturnType<typeof useStore.getState>['settings']): number {
  const sep = settings.activeModel.indexOf(':')
  const providerId = settings.activeModel.slice(0, sep)
  const modelId = settings.activeModel.slice(sep + 1)
  const provider = settings.providers.find((entry) => entry.id === providerId)
  return provider?.models.find((entry) => entry.id === modelId)?.contextWindow ?? 0
}

function compact(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`
  if (value >= 1_000) return `${Math.round(value / 1_000)}k`
  return String(value)
}
