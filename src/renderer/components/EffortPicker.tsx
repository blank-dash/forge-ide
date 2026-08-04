import { useEffect, useRef } from 'react'
import { EFFORT_LEVELS, effortToBudget } from '@shared/types'
import type { ModelConfig, ProviderKind, ReasoningEffort } from '@shared/types'
import { useStore } from '../store'

type Props = {
  model: ModelConfig | undefined
  kind: ProviderKind | undefined
  onClose(): void
}

const DESCRIPTIONS: Record<ReasoningEffort, string> = {
  off: 'Answer straight away',
  low: 'A little deliberation',
  medium: 'Balanced',
  high: 'Work the problem',
  max: 'As long as it needs'
}

export default function EffortPicker({ model, kind, onClose }: Props) {
  const settings = useStore((state) => state.settings)
  const saveSettings = useStore((state) => state.saveSettings)
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

  return (
    <div className="popover" ref={ref} style={{ minWidth: 260 }}>
      <div className="popover-group">Reasoning effort</div>

      {EFFORT_LEVELS.map((level) => (
        <button
          key={level}
          className={`popover-item ${settings.effort === level ? 'active' : ''}`}
          onClick={() => {
            void saveSettings({ effort: level })
            onClose()
          }}
        >
          <span className="check">{settings.effort === level ? '✓' : ''}</span>
          <span>{level}</span>
          <span className="sub">{cost(level, kind, model)}</span>
        </button>
      ))}

      <div className="popover-note">{DESCRIPTIONS[settings.effort]}</div>
    </div>
  )
}

/** What the level actually turns into for this provider, so it is not a mystery dial. */
function cost(
  level: ReasoningEffort,
  kind: ProviderKind | undefined,
  model: ModelConfig | undefined
): string {
  if (level === 'off') return '—'
  if (kind === 'openai') return level === 'max' ? 'high' : level

  const budget = model?.thinkingBudget ?? effortToBudget(level, model?.maxOutputTokens ?? 8_192)
  return `${Math.round(budget / 1000)}k tokens`
}
