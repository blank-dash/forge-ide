import { useCallback, useEffect, useRef, useState } from 'react'
import type { EditApproval, ProviderConfig, Settings } from '@shared/types'
import { useStore } from '../store'
import McpSettings from './McpSettings'
import ProviderEditor from './ProviderEditor'

const SECTIONS = [
  { id: 'providers', label: 'Providers & models' },
  { id: 'mcp', label: 'MCP servers' },
  { id: 'permissions', label: 'Permissions' },
  { id: 'behaviour', label: 'Agent behaviour' },
  { id: 'appearance', label: 'Appearance' },
  { id: 'about', label: 'About' }
] as const

export default function SettingsModal() {
  const stored = useStore((state) => state.settings)
  const section = useStore((state) => state.ui.settingsSection)
  const patchUi = useStore((state) => state.patchUi)
  const bootstrap = useStore((state) => state.bootstrap)
  const mcpStatuses = useStore((state) => state.mcp)

  const [draft, setDraft] = useState<Settings>(stored)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const dirty = JSON.stringify(draft) !== JSON.stringify(stored)
  const close = useCallback(() => patchUi({ settingsOpen: false }), [patchUi])

  /**
   * The agent writes settings too: an "always allow" answer adds a rule, and
   * dragging a panel saves the layout. Without folding those in, saving this
   * dialog would quietly undo them — so every key the user has not touched
   * follows what is on disk.
   */
  const syncedFrom = useRef(stored)
  useEffect(() => {
    const previous = syncedFrom.current
    if (previous === stored) return
    syncedFrom.current = stored

    setDraft((current) => {
      const merged = { ...current } as Record<string, unknown>
      const before = previous as unknown as Record<string, unknown>
      const after = stored as unknown as Record<string, unknown>

      for (const key of Object.keys(after)) {
        const changedExternally = JSON.stringify(before[key]) !== JSON.stringify(after[key])
        const untouchedHere = JSON.stringify(merged[key]) === JSON.stringify(before[key])
        if (changedExternally && untouchedHere) merged[key] = after[key]
      }
      return merged as unknown as Settings
    })
  }, [stored])

  const save = useCallback(async () => {
    setSaving(true)
    setError(null)
    try {
      const next = await window.forge.settings.set(draft)
      useStore.getState().setSettings(next)
      setDraft(next)
    } catch (saveError) {
      setError((saveError as Error).message)
    } finally {
      setSaving(false)
    }
  }, [draft])

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') close()
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault()
        void save()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [close, save])

  const patch = (partial: Partial<Settings>): void =>
    setDraft((current) => ({ ...current, ...partial }))

  return (
    <div className="overlay" onMouseDown={(event) => event.target === event.currentTarget && close()}>
      <div className="dialog settings">
        <nav className="settings-nav">
          {SECTIONS.map((entry) => (
            <button
              key={entry.id}
              className={section === entry.id ? 'active' : ''}
              onClick={() => patchUi({ settingsSection: entry.id })}
            >
              {entry.label}
            </button>
          ))}
          <span style={{ flex: 1 }} />
          <button onClick={close}>Close</button>
        </nav>

        <div className="settings-main">
          <div className="settings-scroll">
            {section === 'providers' && (
              <>
                <h3>Providers &amp; models</h3>
                <p>
                  Connect any model you have an API key for. Pick the API format your endpoint
                  speaks — most third-party and local servers speak OpenAI — set the base URL, and
                  add the model ids you want in the picker. Every model can carry its own context
                  window, limits, pricing and request parameters.
                </p>

                {draft.providers.map((provider, index) => (
                  <ProviderEditor
                    key={provider.id}
                    provider={provider}
                    onChange={(next) =>
                      patch({
                        providers: draft.providers.map((entry, i) => (i === index ? next : entry))
                      })
                    }
                    onRemove={() =>
                      patch({ providers: draft.providers.filter((_, i) => i !== index) })
                    }
                  />
                ))}

                <button
                  className="btn"
                  style={{ marginTop: 8 }}
                  onClick={() =>
                    patch({ providers: [...draft.providers, newProvider(draft.providers)] })
                  }
                >
                  + Add custom provider
                </button>
              </>
            )}

            {section === 'mcp' && (
              <McpSettings
                servers={draft.mcpServers}
                statuses={mcpStatuses}
                onChange={(mcpServers) => patch({ mcpServers })}
              />
            )}

            {section === 'permissions' && (
              <>
                <h3>Permissions</h3>
                <p>
                  Chat mode is a hard read-only boundary — no rule can unlock it. In Edit mode the
                  settings below decide how much you get asked.
                </p>

                <div className="row">
                  <div className="field">
                    <label>Mode</label>
                    <select
                      className="select"
                      value={draft.mode}
                      onChange={(event) =>
                        patch({ mode: event.target.value as Settings['mode'] })
                      }
                    >
                      <option value="chat">Chat — read-only</option>
                      <option value="agent">Edit — the agent can change files</option>
                    </select>
                  </div>
                  <div className="field">
                    <label>Edits</label>
                    <select
                      className="select"
                      value={draft.editApproval}
                      onChange={(event) =>
                        patch({ editApproval: event.target.value as EditApproval })
                      }
                    >
                      <option value="review">Apply, then review</option>
                      <option value="ask">Ask before each edit</option>
                      <option value="auto">Apply silently</option>
                    </select>
                  </div>
                  <div className="field">
                    <label>Shell commands</label>
                    <select
                      className="select"
                      value={draft.commandApproval}
                      onChange={(event) =>
                        patch({
                          commandApproval: event.target.value as Settings['commandApproval']
                        })
                      }
                    >
                      <option value="ask">Ask every time</option>
                      <option value="auto">Run without asking</option>
                    </select>
                  </div>
                </div>

                <RuleList
                  title="Always allow"
                  hint="Rules like Bash(git status *), Edit(src/**), Write(docs/**). Added automatically when you pick “always allow” in a prompt."
                  rules={draft.allowRules}
                  placeholder="Bash(npm test *)"
                  onChange={(allowRules) => patch({ allowRules })}
                />

                <RuleList
                  title="Always deny"
                  hint="Checked first and wins over everything else."
                  rules={draft.denyRules}
                  placeholder="Bash(git push *)"
                  onChange={(denyRules) => patch({ denyRules })}
                />

                <RuleList
                  title="Folders outside the workspace"
                  hint="Directories the agent may read and write outside the open project. Added when you approve an outside path with “always allow”."
                  rules={draft.externalRoots}
                  placeholder="C:\\Users\\me\\notes"
                  onChange={(externalRoots) => patch({ externalRoots })}
                />
              </>
            )}

            {section === 'behaviour' && (
              <>
                <h3>Agent behaviour</h3>
                <p>Defaults for every model. Individual models can override them.</p>

                <div className="row">
                  <div className="field">
                    <label>Max output tokens per turn</label>
                    <input
                      className="input"
                      type="number"
                      value={draft.maxOutputTokens}
                      onChange={(event) =>
                        patch({ maxOutputTokens: Number(event.target.value) || 0 })
                      }
                    />
                  </div>
                  <div className="field">
                    <label>Temperature</label>
                    <input
                      className="input"
                      type="number"
                      step="0.1"
                      min="0"
                      max="2"
                      value={draft.temperature}
                      onChange={(event) => patch({ temperature: Number(event.target.value) })}
                    />
                  </div>
                  <div className="field">
                    <label>Reasoning effort</label>
                    <select
                      className="select"
                      value={draft.effort}
                      onChange={(event) =>
                        patch({ effort: event.target.value as Settings['effort'] })
                      }
                    >
                      <option value="off">Off — answer directly</option>
                      <option value="low">Low</option>
                      <option value="medium">Medium</option>
                      <option value="high">High</option>
                      <option value="max">Max — think as long as it needs</option>
                    </select>
                  </div>
                </div>

                <div className="hint" style={{ marginTop: -6, marginBottom: 14 }}>
                  Applies to models flagged as reasoning models. It becomes a thinking-token
                  budget on Anthropic and Gemini, and <code>reasoning_effort</code> on OpenAI. A
                  per-model thinking budget overrides it, except at Off.
                </div>

                <label className="switch">
                  <input
                    type="checkbox"
                    checked={draft.showThinking}
                    onChange={(event) => patch({ showThinking: event.target.checked })}
                  />
                  Show the model&apos;s thinking in the transcript
                </label>

                <label className="switch">
                  <input
                    type="checkbox"
                    checked={draft.autoSaveSessions}
                    onChange={(event) => patch({ autoSaveSessions: event.target.checked })}
                  />
                  Save conversations so they can be reopened later
                </label>

                <div className="field" style={{ marginTop: 14 }}>
                  <label>Custom instructions</label>
                  <textarea
                    className="textarea"
                    value={draft.customInstructions}
                    placeholder="Appended to the system prompt for every session — coding conventions, preferred libraries, tone."
                    onChange={(event) => patch({ customInstructions: event.target.value })}
                  />
                  <div className="hint">
                    Per-project instructions go in a FORGE.md, AGENTS.md or CLAUDE.md at the
                    workspace root — those are picked up automatically.
                  </div>
                </div>
              </>
            )}

            {section === 'appearance' && (
              <>
                <h3>Appearance</h3>
                <p>Fonts and colours for the editor and the agent panel.</p>

                <div className="row">
                  <div className="field">
                    <label>Theme</label>
                    <select
                      className="select"
                      value={draft.theme}
                      onChange={(event) => patch({ theme: event.target.value as Settings['theme'] })}
                    >
                      <option value="dark">Dark</option>
                      <option value="light">Light</option>
                    </select>
                  </div>
                  <div className="field narrow">
                    <label>Accent</label>
                    <input
                      className="input"
                      type="color"
                      value={draft.accent}
                      onChange={(event) => patch({ accent: event.target.value })}
                    />
                  </div>
                </div>

                <div className="field">
                  <label>Monospace font stack</label>
                  <input
                    className="input mono"
                    value={draft.fontFamily}
                    onChange={(event) => patch({ fontFamily: event.target.value })}
                  />
                </div>

                <div className="row">
                  <div className="field">
                    <label>Editor font size</label>
                    <input
                      className="input"
                      type="number"
                      value={draft.editorFontSize}
                      onChange={(event) =>
                        patch({ editorFontSize: Number(event.target.value) || 13 })
                      }
                    />
                  </div>
                  <div className="field">
                    <label>Chat font size</label>
                    <input
                      className="input"
                      type="number"
                      value={draft.chatFontSize}
                      onChange={(event) => patch({ chatFontSize: Number(event.target.value) || 13 })}
                    />
                  </div>
                </div>
              </>
            )}

            {section === 'about' && (
              <>
                <h3>Forge {bootstrap?.appVersion}</h3>
                <p>An agentic IDE that works with whatever model you bring.</p>

                <UpdatePanel />

                <div className="field">
                  <label>Where your configuration lives</label>
                  <div className="code-box">{bootstrap?.settingsPath}</div>
                  <div className="hint">
                    Every provider, model, rule and approved folder is written here the moment you
                    change it, atomically, with a <code>.bak</code> kept alongside. Nothing is sent
                    anywhere. A build run from source uses a separate <code>-dev</code> profile, so
                    models added there will not show up in the installed app.
                  </div>
                  <div className="row" style={{ marginTop: 10 }}>
                    <button
                      className="btn"
                      onClick={async () => {
                        try {
                          const target = await window.forge.settings.export()
                          if (target) setError(null)
                        } catch (exportError) {
                          setError((exportError as Error).message)
                        }
                      }}
                    >
                      Export to a file…
                    </button>
                    <button
                      className="btn"
                      onClick={async () => {
                        try {
                          const next = await window.forge.settings.import()
                          if (next) {
                            useStore.getState().setSettings(next)
                            setDraft(next)
                          }
                        } catch (importError) {
                          setError((importError as Error).message)
                        }
                      }}
                    >
                      Import…
                    </button>
                    <span style={{ flex: 2 }} />
                  </div>
                  <div className="hint" style={{ marginTop: 6 }}>
                    API keys stay encrypted in the export, so it only restores on a machine whose
                    keychain can read them. Everything else transfers.
                  </div>
                </div>
                <div className="field">
                  <label>API key storage</label>
                  <div className="hint">
                    {bootstrap?.keysEncrypted
                      ? 'Encrypted with the OS keychain (DPAPI / Keychain / libsecret).'
                      : 'The OS keychain is unavailable, so keys are stored in plain text in the settings file above.'}
                  </div>
                </div>
                <div className="field">
                  <label>Environment</label>
                  <div className="hint">
                    {bootstrap?.shellLabel} on {bootstrap?.platform} ·{' '}
                    {bootstrap?.gitAvailable ? 'git found' : 'git not found'}
                  </div>
                </div>
              </>
            )}
          </div>

          <div className="dialog-foot">
            <button
              className="btn btn-primary"
              onClick={() => void save()}
              disabled={!dirty || saving}
            >
              {saving ? 'Saving…' : dirty ? 'Save changes' : 'Saved'}
            </button>
            <button className="btn" onClick={() => setDraft(stored)} disabled={!dirty}>
              Revert
            </button>
            {error && <span style={{ color: 'var(--red)', fontSize: 12 }}>{error}</span>}
            <span className="kbd-hint">Ctrl+S save · Esc close</span>
          </div>
        </div>
      </div>
    </div>
  )
}

function UpdatePanel() {
  const initial = useStore((state) => state.bootstrap?.updates)
  const [status, setStatus] = useState(initial)
  const [busy, setBusy] = useState(false)

  useEffect(() => window.forge.updates.onStatus(setStatus), [])

  if (!status?.supported) {
    return (
      <div className="field">
        <label>Updates</label>
        <div className="hint">
          Available in the installed build only — a checkout run from source updates with git.
        </div>
      </div>
    )
  }

  const run = async (action: () => Promise<unknown>): Promise<void> => {
    setBusy(true)
    try {
      await action()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="field">
      <label>Updates</label>

      <div className="row" style={{ alignItems: 'center' }}>
        {status.state === 'ready' ? (
          <button
            className="btn btn-primary"
            disabled={busy}
            onClick={() => void run(() => window.forge.updates.install())}
          >
            Restart and install {status.version}
          </button>
        ) : status.state === 'available' ? (
          <button
            className="btn btn-primary"
            disabled={busy}
            onClick={() => void run(() => window.forge.updates.download())}
          >
            Download {status.version}
          </button>
        ) : (
          <button
            className="btn"
            disabled={busy || status.state === 'checking' || status.state === 'downloading'}
            onClick={() => void run(() => window.forge.updates.check())}
          >
            {status.state === 'checking' ? 'Checking…' : 'Check for updates'}
          </button>
        )}
        <span style={{ flex: 3 }} />
      </div>

      <div className="hint" style={{ color: status.state === 'error' ? 'var(--red)' : undefined }}>
        {describeUpdate(status)}
      </div>

      {status.notes && <div className="code-box" style={{ marginTop: 8 }}>{status.notes}</div>}
    </div>
  )
}

function describeUpdate(status: NonNullable<ReturnType<typeof useStore.getState>['bootstrap']>['updates']): string {
  switch (status.state) {
    case 'checking':
      return 'Looking for a newer release…'
    case 'available':
      return `Version ${status.version} is available. Nothing downloads until you say so.`
    case 'downloading':
      return `Downloading… ${status.percent ?? 0}%`
    case 'ready':
      return `Version ${status.version} is ready. Forge will restart to install it.`
    case 'none':
      return 'You are on the latest release.'
    case 'error':
      return status.message ?? 'The update check failed.'
    default:
      return 'Checked automatically every few hours.'
  }
}

type RuleListProps = {
  title: string
  hint: string
  rules: string[]
  placeholder: string
  onChange(next: string[]): void
}

function RuleList({ title, hint, rules, placeholder, onChange }: RuleListProps) {
  const [value, setValue] = useState('')

  const add = (): void => {
    const trimmed = value.trim()
    if (!trimmed || rules.includes(trimmed)) return
    onChange([...rules, trimmed])
    setValue('')
  }

  return (
    <>
      <h4>{title}</h4>
      <div className="rule-list">
        {rules.length === 0 && <div className="hint">Nothing here yet.</div>}
        {rules.map((rule) => (
          <div className="rule-item" key={rule}>
            <span>{rule}</span>
            <button
              className="icon-btn danger"
              onClick={() => onChange(rules.filter((entry) => entry !== rule))}
            >
              ×
            </button>
          </div>
        ))}
      </div>
      <div className="row">
        <input
          className="input mono"
          placeholder={placeholder}
          value={value}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => event.key === 'Enter' && add()}
        />
        <button className="btn narrow" onClick={add}>
          Add
        </button>
      </div>
      <div className="hint" style={{ marginTop: 6 }}>
        {hint}
      </div>
    </>
  )
}

function newProvider(existing: ProviderConfig[]): ProviderConfig {
  let index = existing.length + 1
  while (existing.some((provider) => provider.id === `custom-${index}`)) index++
  return {
    id: `custom-${index}`,
    name: `Custom provider ${index}`,
    kind: 'openai',
    baseUrl: 'https://api.example.com/v1',
    apiKey: '',
    headers: {},
    models: [],
    builtin: false,
    enabled: true
  }
}
