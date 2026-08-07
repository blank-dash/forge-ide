import { useState } from 'react'
import { detectsThinking, detectsVision } from '@shared/types'
import type { ModelConfig, ProviderConfig, ProviderTestResult } from '@shared/types'

type Props = {
  provider: ProviderConfig
  onChange(next: ProviderConfig): void
  onRemove(): void
}

export default function ProviderEditor({ provider, onChange, onRemove }: Props) {
  const [open, setOpen] = useState(false)
  const [test, setTest] = useState<ProviderTestResult | null>(null)
  const [busy, setBusy] = useState<'test' | 'models' | null>(null)
  const [discovered, setDiscovered] = useState<string[] | null>(null)
  const [draftModel, setDraftModel] = useState('')

  const patch = (partial: Partial<ProviderConfig>): void => onChange({ ...provider, ...partial })

  const runTest = async (): Promise<void> => {
    setBusy('test')
    setTest(null)
    try {
      setTest(await window.forge.providers.test(provider))
    } catch (error) {
      setTest({ ok: false, message: (error as Error).message })
    } finally {
      setBusy(null)
    }
  }

  const fetchModels = async (): Promise<void> => {
    setBusy('models')
    try {
      setDiscovered(await window.forge.providers.listModels(provider))
    } catch (error) {
      setTest({ ok: false, message: (error as Error).message })
    } finally {
      setBusy(null)
    }
  }

  const addModel = (id: string): void => {
    const trimmed = id.trim()
    if (!trimmed || provider.models.some((model) => model.id === trimmed)) return
    patch({ models: [...provider.models, blankModel(trimmed)] })
  }

  return (
    <div className="provider-card">
      <div className="provider-head" onClick={() => setOpen((value) => !value)}>
        <span className="tree-caret" style={{ transform: open ? 'rotate(90deg)' : undefined }}>
          ▶
        </span>
        <span className="name">{provider.name}</span>
        <span className={`badge ${provider.apiKey ? 'ok' : 'off'}`}>
          {provider.apiKey ? 'key set' : 'no key'}
        </span>
        <span className="badge">{provider.kind}</span>
        <span className="meta">{provider.baseUrl}</span>
        <span style={{ flex: 1 }} />
        <label className="switch" onClick={(event) => event.stopPropagation()}>
          <input
            type="checkbox"
            checked={provider.enabled}
            onChange={(event) => patch({ enabled: event.target.checked })}
          />
        </label>
      </div>

      {open && (
        <div className="provider-body">
          <div className="row" style={{ marginTop: 12 }}>
            <div className="field">
              <label>Display name</label>
              <input
                className="input"
                value={provider.name}
                onChange={(event) => patch({ name: event.target.value })}
              />
            </div>
            <div className="field narrow">
              <label>API format</label>
              <select
                className="select"
                value={provider.kind}
                onChange={(event) => patch({ kind: event.target.value as ProviderConfig['kind'] })}
                disabled={provider.builtin}
              >
                <option value="openai">OpenAI</option>
                <option value="anthropic">Anthropic</option>
                <option value="google">Gemini</option>
              </select>
            </div>
          </div>

          <div className="field">
            <label>Base URL</label>
            <input
              className="input mono"
              value={provider.baseUrl}
              spellCheck={false}
              onChange={(event) => patch({ baseUrl: event.target.value.replace(/\/+$/, '') })}
            />
            <div className="hint">{baseUrlHint(provider.kind)}</div>
          </div>

          <div className="field">
            <label>API key</label>
            <input
              className="input mono"
              type="password"
              value={provider.apiKey}
              placeholder="sk-…"
              spellCheck={false}
              autoComplete="off"
              onChange={(event) => patch({ apiKey: event.target.value })}
            />
            <div className="hint">
              Stored on this machine only, encrypted with the OS keychain when available. Never sent
              anywhere except this provider&apos;s base URL.
            </div>
          </div>

          <div className="field">
            <label>Extra headers (JSON)</label>
            <JsonField
              value={provider.headers ?? {}}
              onChange={(headers) => patch({ headers: headers as Record<string, string> })}
            />
          </div>

          <h4>Models</h4>
          {provider.models.map((model, index) => (
            <ModelRow
              key={`${model.id}-${index}`}
              model={model}
              onChange={(next) =>
                patch({ models: provider.models.map((entry, i) => (i === index ? next : entry)) })
              }
              onRemove={() => patch({ models: provider.models.filter((_, i) => i !== index) })}
            />
          ))}

          <div className="row" style={{ marginTop: 10 }}>
            <input
              className="input mono"
              placeholder="Add a model id, e.g. gpt-4.1 or llama3.1:8b"
              value={draftModel}
              spellCheck={false}
              onChange={(event) => setDraftModel(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  addModel(draftModel)
                  setDraftModel('')
                }
              }}
            />
            <button
              className="btn narrow"
              onClick={() => {
                addModel(draftModel)
                setDraftModel('')
              }}
            >
              Add
            </button>
            <button
              className="btn narrow"
              onClick={() => void fetchModels()}
              disabled={busy !== null}
            >
              {busy === 'models' ? 'Loading…' : 'Fetch list'}
            </button>
          </div>

          {discovered && (
            <div style={{ marginTop: 10 }}>
              <div className="hint" style={{ marginBottom: 6 }}>
                {discovered.length} models reported by the provider — click to add.
              </div>
              <div className="chip-wrap">
                {discovered
                  .filter(
                    (id) => !draftModel || id.toLowerCase().includes(draftModel.toLowerCase())
                  )
                  .map((id) => (
                    <button
                      key={id}
                      className="pill"
                      onClick={() => addModel(id)}
                      disabled={provider.models.some((model) => model.id === id)}
                    >
                      {id}
                    </button>
                  ))}
              </div>
            </div>
          )}

          <div className="row" style={{ marginTop: 16, alignItems: 'center' }}>
            <button className="btn" onClick={() => void runTest()} disabled={busy !== null}>
              {busy === 'test' ? 'Testing…' : 'Test connection'}
            </button>
            {!provider.builtin && (
              <button className="btn btn-danger narrow" onClick={onRemove}>
                Delete provider
              </button>
            )}
            <span style={{ flex: 3 }} />
          </div>

          {test && (
            <div className={`test-result ${test.ok ? 'ok' : 'err'}`}>
              {test.ok ? '✓ ' : '✕ '}
              {test.message}
              {test.latencyMs != null && test.ok && ` (${test.latencyMs} ms)`}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ */

type ModelRowProps = {
  model: ModelConfig
  onChange(next: ModelConfig): void
  onRemove(): void
}

function ModelRow({ model, onChange, onRemove }: ModelRowProps) {
  const [advanced, setAdvanced] = useState(false)
  const update = (partial: Partial<ModelConfig>): void => onChange({ ...model, ...partial })

  return (
    <div className="model-row">
      <div className="model-line">
        <input
          className="input mono"
          style={{ flex: 2 }}
          value={model.id}
          spellCheck={false}
          onChange={(event) => update({ id: event.target.value })}
        />
        <input
          className="input"
          style={{ flex: 1.4 }}
          value={model.label}
          placeholder="Display name"
          onChange={(event) => update({ label: event.target.value })}
        />
        <NumberField
          label="context"
          value={model.contextWindow}
          onChange={(contextWindow) => update({ contextWindow })}
        />
        <NumberField
          label="max out"
          value={model.maxOutputTokens}
          onChange={(maxOutputTokens) => update({ maxOutputTokens })}
        />
        <button
          className={`icon-btn ${advanced ? 'active' : ''}`}
          title="Advanced parameters"
          onClick={() => setAdvanced((value) => !value)}
        >
          ⚙
        </button>
        <button className="icon-btn danger" title="Remove model" onClick={onRemove}>
          ×
        </button>
      </div>

      <div className="model-line subtle">
        <Capability
          label="tools"
          hint="The model can call tools. Off means it can only talk."
          checked={model.supportsTools}
          onChange={(supportsTools) => update({ supportsTools })}
        />
        <Capability
          label="vision"
          hint="Accepts images."
          checked={model.supportsVision}
          onChange={(supportsVision) => update({ supportsVision })}
        />
        <Capability
          label="thinking"
          hint="Reasoning model — enables the thinking budget and suppresses temperature."
          checked={model.supportsThinking}
          onChange={(supportsThinking) => update({ supportsThinking })}
        />
        <span style={{ flex: 1 }} />
        <NumberField
          label="$/Mtok in"
          value={model.pricing?.input ?? 0}
          step={0.01}
          onChange={(input) => update({ pricing: { input, output: model.pricing?.output ?? 0 } })}
        />
        <NumberField
          label="$/Mtok out"
          value={model.pricing?.output ?? 0}
          step={0.01}
          onChange={(output) => update({ pricing: { input: model.pricing?.input ?? 0, output } })}
        />
      </div>

      {advanced && (
        <div className="model-advanced">
          <div className="row">
            <div className="field">
              <label>Temperature override</label>
              <input
                className="input mono"
                type="number"
                step="0.1"
                placeholder="use global"
                value={model.temperature ?? ''}
                onChange={(event) =>
                  update({
                    temperature: event.target.value === '' ? null : Number(event.target.value)
                  })
                }
              />
            </div>
            <div className="field">
              <label>Thinking budget override</label>
              <input
                className="input mono"
                type="number"
                placeholder="use global"
                value={model.thinkingBudget ?? ''}
                onChange={(event) =>
                  update({
                    thinkingBudget: event.target.value === '' ? null : Number(event.target.value)
                  })
                }
              />
            </div>
            <div className="field">
              <label>Context fill before trimming</label>
              <input
                className="input mono"
                type="number"
                step="0.05"
                min="0.2"
                max="0.95"
                placeholder="0.75"
                value={model.contextThreshold ?? ''}
                onChange={(event) =>
                  update({
                    contextThreshold: event.target.value === '' ? null : Number(event.target.value)
                  })
                }
              />
            </div>
          </div>

          <div className="field">
            <label>Extra request body (JSON)</label>
            <JsonField
              value={model.extraBody ?? {}}
              placeholder='{"top_p": 0.9, "reasoning_effort": "high"}'
              onChange={(extraBody) => update({ extraBody })}
            />
            <div className="hint">
              Merged into the request last, so it overrides anything Forge sets. Use it for
              parameters your endpoint supports that are not listed above.
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

type NumberFieldProps = {
  label: string
  value: number
  step?: number
  onChange(next: number): void
}

function NumberField({ label, value, step, onChange }: NumberFieldProps) {
  return (
    <input
      className="input mono narrow-number"
      type="number"
      step={step}
      value={value}
      title={label}
      placeholder={label}
      onChange={(event) => onChange(Number(event.target.value) || 0)}
    />
  )
}

type CapabilityProps = {
  label: string
  hint: string
  checked: boolean
  onChange(next: boolean): void
}

function Capability({ label, hint, checked, onChange }: CapabilityProps) {
  return (
    <label className="switch small" title={hint}>
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
      {label}
    </label>
  )
}

type JsonFieldProps = {
  value: Record<string, unknown>
  placeholder?: string
  onChange(next: Record<string, unknown>): void
}

/**
 * Keeps the raw text the user is typing so a half-finished object does not get
 * thrown away on every keystroke, and only commits once it parses.
 */
function JsonField({ value, placeholder, onChange }: JsonFieldProps) {
  const [text, setText] = useState(() => JSON.stringify(value ?? {}, null, 0))
  const [invalid, setInvalid] = useState(false)

  return (
    <>
      <textarea
        className="textarea mono"
        style={{ minHeight: 52, borderColor: invalid ? 'var(--red)' : undefined }}
        value={text}
        placeholder={placeholder ?? '{}'}
        spellCheck={false}
        onChange={(event) => {
          const next = event.target.value
          setText(next)
          try {
            const parsed = JSON.parse(next || '{}')
            setInvalid(false)
            onChange(parsed as Record<string, unknown>)
          } catch {
            setInvalid(true)
          }
        }}
      />
      {invalid && (
        <div className="hint" style={{ color: 'var(--red)' }}>
          Not valid JSON yet.
        </div>
      )}
    </>
  )
}

/**
 * Capabilities are inferred from the id so a model added by hand behaves
 * correctly straight away. Every guess stays editable on the row below.
 */
function blankModel(id: string): ModelConfig {
  const thinking = detectsThinking(id)
  return {
    id,
    label: id,
    contextWindow: 128_000,
    maxOutputTokens: thinking ? 32_000 : 8_192,
    supportsTools: true,
    supportsVision: detectsVision(id),
    supportsThinking: thinking
  }
}

function baseUrlHint(kind: ProviderConfig['kind']): string {
  switch (kind) {
    case 'openai':
      return 'Anything OpenAI-compatible: OpenRouter, Groq, DeepSeek, Together, xAI, Mistral, vLLM, Ollama (http://localhost:11434/v1), LM Studio (http://localhost:1234/v1). Requests go to {base}/chat/completions.'
    case 'anthropic':
      return 'Anthropic Messages API, or a compatible gateway. Requests go to {base}/v1/messages.'
    case 'google':
      return 'Gemini API. Requests go to {base}/models/{model}:streamGenerateContent.'
  }
}
