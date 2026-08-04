import { useMemo, useState } from 'react'
import type { ProviderConfig, ProviderTestResult, Settings } from '@shared/types'
import { useStore } from '../store'

type Step = 'welcome' | 'model' | 'folder' | 'done'

const THEMES: Array<{ id: Settings['theme']; label: string }> = [
  { id: 'warm-dark', label: 'Warm dark' },
  { id: 'true-black', label: 'True black' },
  { id: 'high-contrast', label: 'High contrast' },
  { id: 'midnight', label: 'Midnight' },
  { id: 'light', label: 'Light' }
]

/**
 * First run. Three decisions, in the order they actually block you: how it
 * looks, which model answers, and which folder you are working in.
 */
export default function SetupWizard() {
  const settings = useStore((state) => state.settings)
  const saveSettings = useStore((state) => state.saveSettings)
  const bootstrap = useStore((state) => state.bootstrap)

  const [step, setStep] = useState<Step>('welcome')
  const [providerId, setProviderId] = useState('anthropic')
  const [apiKey, setApiKey] = useState('')
  const [test, setTest] = useState<ProviderTestResult | null>(null)
  const [busy, setBusy] = useState(false)

  const provider = useMemo(
    () => settings.providers.find((entry) => entry.id === providerId),
    [settings.providers, providerId]
  )

  const finish = async (): Promise<void> => {
    await saveSettings({ setupCompleted: true })
  }

  const saveKey = async (): Promise<void> => {
    if (!provider) return
    setBusy(true)
    setTest(null)
    try {
      const candidate: ProviderConfig = { ...provider, apiKey: apiKey.trim(), enabled: true }
      const result = await window.forge.providers.test(candidate)
      setTest(result)

      if (result.ok) {
        await saveSettings({
          providers: settings.providers.map((entry) =>
            entry.id === providerId ? candidate : entry
          ),
          activeModel: `${providerId}:${candidate.models[0]?.id ?? ''}`
        })
        setStep('folder')
      }
    } catch (error) {
      setTest({ ok: false, message: (error as Error).message })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="overlay">
      <div className="dialog wizard">
        <div className="wizard-rail">
          <BrandBlock />
          <ol className="wizard-steps">
            <li className={step === 'welcome' ? 'active' : ''}>Appearance</li>
            <li className={step === 'model' ? 'active' : ''}>Model</li>
            <li className={step === 'folder' ? 'active' : ''}>Project</li>
            <li className={step === 'done' ? 'active' : ''}>Ready</li>
          </ol>
        </div>

        <div className="wizard-body">
          {step === 'welcome' && (
            <>
              <h2>Welcome to Forge</h2>
              <p>
                An IDE where the agent is a first-class part of the window, and the model is
                whichever one you have a key for.
              </p>

              <h4>Theme</h4>
              <div className="row" style={{ marginBottom: 18, flexWrap: 'wrap' }}>
                {THEMES.map((option) => (
                  <button
                    key={option.id}
                    className={`theme-card ${settings.theme === option.id ? 'active' : ''}`}
                    onClick={() => void saveSettings({ theme: option.id })}
                  >
                    <span className={`theme-swatch ${option.id}`} />
                    {option.label}
                  </button>
                ))}
              </div>

              <div className="wizard-actions">
                <button className="btn btn-primary" onClick={() => setStep('model')}>
                  Continue
                </button>
                <button className="btn" onClick={() => void finish()}>
                  Skip setup
                </button>
              </div>
            </>
          )}

          {step === 'model' && (
            <>
              <h2>Connect a model</h2>
              <p>
                The key is stored on this machine only, encrypted with the OS keychain when one is
                available, and sent nowhere except that provider.
              </p>

              <div className="field">
                <label>Provider</label>
                <select
                  className="select"
                  value={providerId}
                  onChange={(event) => {
                    setProviderId(event.target.value)
                    setTest(null)
                  }}
                >
                  {settings.providers.map((entry) => (
                    <option key={entry.id} value={entry.id}>
                      {entry.name}
                    </option>
                  ))}
                </select>
                <div className="hint">{provider?.baseUrl}</div>
              </div>

              <div className="field">
                <label>API key</label>
                <input
                  className="input mono"
                  type="password"
                  value={apiKey}
                  placeholder={isLocal(provider) ? 'not needed for a local server' : 'sk-…'}
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(event) => setApiKey(event.target.value)}
                  onKeyDown={(event) => event.key === 'Enter' && void saveKey()}
                />
              </div>

              {test && (
                <div className={`test-result ${test.ok ? 'ok' : 'err'}`}>
                  {test.ok ? '✓ ' : '✕ '}
                  {test.message}
                </div>
              )}

              <div className="wizard-actions">
                <button
                  className="btn btn-primary"
                  disabled={busy || (!apiKey.trim() && !isLocal(provider))}
                  onClick={() => void saveKey()}
                >
                  {busy ? 'Testing…' : 'Test and continue'}
                </button>
                <button className="btn" onClick={() => setStep('folder')}>
                  Later
                </button>
              </div>
            </>
          )}

          {step === 'folder' && (
            <>
              <h2>Open a project</h2>
              <p>
                Forge works inside one folder at a time. The agent can read and edit anything in
                it; anywhere else on the machine needs your approval first.
              </p>

              <div className="field">
                <label>Current folder</label>
                <div className="code-box">{bootstrap?.cwd}</div>
              </div>

              <div className="wizard-actions">
                <button
                  className="btn btn-primary"
                  onClick={async () => {
                    const picked = await window.forge.workspace.pick()
                    if (picked) {
                      await finish()
                      window.location.reload()
                      return
                    }
                    setStep('done')
                  }}
                >
                  Choose a folder…
                </button>
                <button className="btn" onClick={() => setStep('done')}>
                  Use this one
                </button>
              </div>
            </>
          )}

          {step === 'done' && (
            <>
              <h2>You&apos;re set</h2>
              <p>Two modes, and you can switch at any time from the title bar.</p>

              <ul className="wizard-list">
                <li>
                  <strong>Chat</strong> — the whole window is the conversation, with history down
                  the left. Read-only: the agent can look but not touch.
                </li>
                <li>
                  <strong>Edit</strong> — editor, file tree and agent side by side. Changes land in
                  a review screen where you keep or revert each file.
                </li>
              </ul>

              <p className="hint">
                <code>/</code> for commands, <code>@</code> for files, <code>Ctrl</code>+
                <code>,</code> for settings.
              </p>

              <div className="wizard-actions">
                <button className="btn btn-primary" onClick={() => void finish()}>
                  Start working
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

function isLocal(provider: ProviderConfig | undefined): boolean {
  return /localhost|127\.0\.0\.1/.test(provider?.baseUrl ?? '')
}

function BrandBlock() {
  return (
    <div className="wizard-brand">
      <svg viewBox="0 0 512 512" aria-hidden="true">
        <rect width="512" height="512" rx="100" fill="#061A23" />
        <g stroke="url(#wizardGradient)" fill="url(#wizardGradient)">
          <path
            d="M142 148 L270 256 L142 364"
            strokeWidth="48"
            strokeLinecap="round"
            strokeLinejoin="round"
            fill="none"
          />
          <rect x="284" y="346" width="110" height="42" rx="21" stroke="none" />
        </g>
        <defs>
          <linearGradient
            id="wizardGradient"
            x1="150"
            y1="140"
            x2="380"
            y2="390"
            gradientUnits="userSpaceOnUse"
          >
            <stop stopColor="#FFFFFF" />
            <stop offset="1" stopColor="#D0D0D0" />
          </linearGradient>
        </defs>
      </svg>
      <span>Forge</span>
    </div>
  )
}
