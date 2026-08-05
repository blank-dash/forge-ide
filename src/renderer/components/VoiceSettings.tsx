import { useEffect, useMemo, useState } from 'react'
import type { Settings } from '@shared/types'
import { useT } from '../i18n'
import { speak, systemVoices } from '../voice'
import Select from './Select'

type Props = {
  draft: Settings
  patch: (partial: Partial<Settings>) => void
}

/** Common transcription models, so nobody has to guess the exact id. */
const TRANSCRIBE_MODELS = ['whisper-1', 'gpt-4o-transcribe', 'gpt-4o-mini-transcribe']
const SPEAK_MODELS = ['tts-1', 'tts-1-hd', 'gpt-4o-mini-tts']
const API_VOICES = ['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer']

export default function VoiceSettings({ draft, patch }: Props) {
  const t = useT()
  const [voices, setVoices] = useState<Array<{ name: string; lang: string }>>([])
  const voice = draft.voice

  useEffect(() => {
    void systemVoices().then(setVoices)
  }, [])

  const set = (partial: Partial<Settings['voice']>): void =>
    patch({ voice: { ...voice, ...partial } })

  /**
   * Only OpenAI-shaped providers are offered.
   *
   * Anthropic and Google have no speech endpoints at all, and listing them
   * would turn a wrong choice into a puzzling 404 rather than an absence.
   */
  const speechProviders = useMemo(
    () => draft.providers.filter((entry) => entry.kind === 'openai' && entry.enabled && entry.apiKey),
    [draft.providers]
  )

  const modelOptions = (models: string[]): Array<{ value: string; label: string; hint?: string }> => [
    { value: '', label: t('Not set') },
    ...speechProviders.flatMap((provider) =>
      models.map((model) => ({
        value: `${provider.id}:${model}`,
        label: model,
        hint: provider.name
      }))
    )
  ]

  return (
    <>
      <h3>{t('Voice')}</h3>
      <p>
        {t(
          'Speak instead of typing, and have replies read back. Both use a provider you have already configured — there is no separate account and nothing extra to install.'
        )}
      </p>

      {speechProviders.length === 0 && (
        <div className="live-warning">
          {t(
            'No provider here can do speech yet. Speech needs an OpenAI-compatible endpoint — OpenAI itself, Groq, or a local server that speaks the same API. Add one under Providers and give it a key.'
          )}
        </div>
      )}

      <h4 className="settings-subhead">{t('Speaking to it')}</h4>

      <div className="row">
        <div className="field">
          <label>{t('Transcription model')}</label>
          <Select
            value={voice.inputModel}
            onChange={(inputModel) => set({ inputModel })}
            options={modelOptions(TRANSCRIBE_MODELS)}
          />
        </div>
        <div className="field narrow">
          <label>{t('Language')}</label>
          <input
            className="input mono"
            value={voice.inputLanguage}
            placeholder={t('auto')}
            onChange={(event) => set({ inputLanguage: event.target.value.trim() })}
          />
        </div>
      </div>
      <div className="hint">
        {t(
          'A two-letter code such as "ru" or "en" makes recognition noticeably more accurate. Leave it empty and the model works it out, which is fine when you switch languages often.'
        )}
      </div>

      <label className="switch" style={{ marginTop: 12 }}>
        <input
          type="checkbox"
          checked={voice.pushToTalk}
          onChange={(event) => set({ pushToTalk: event.target.checked })}
        />
        {t('Hold the button to talk, release to send')}
      </label>
      <div className="hint">
        {t('With this off the button toggles instead. Esc throws a recording away either way.')}
      </div>

      <h4 className="settings-subhead">{t('It speaking to you')}</h4>

      <div className="field">
        <label>{t('Read replies aloud')}</label>
        <Select
          value={voice.speak}
          onChange={(next) => set({ speak: next as Settings['voice']['speak'] })}
          options={[
            { value: 'off', label: t('Off') },
            {
              value: 'system',
              label: t("This computer's voices"),
              hint: t('Free, works offline, starts instantly')
            },
            {
              value: 'api',
              label: t('A speech model'),
              hint: t('Better voices, costs money per reply')
            }
          ]}
        />
      </div>

      {voice.speak === 'system' && (
        <div className="row">
          <div className="field">
            <label>{t('Voice')}</label>
            <Select
              value={voice.voiceName}
              onChange={(voiceName) => set({ voiceName })}
              options={[
                { value: '', label: t('System default') },
                ...voices.map((entry) => ({
                  value: entry.name,
                  label: entry.name,
                  hint: entry.lang
                }))
              ]}
            />
          </div>
          <div className="field narrow">
            <label>{t('Speed')}</label>
            <Select
              value={String(voice.rate)}
              onChange={(rate) => set({ rate: Number(rate) })}
              options={[
                { value: '0.8', label: '0.8×' },
                { value: '1', label: '1×' },
                { value: '1.25', label: '1.25×' },
                { value: '1.5', label: '1.5×' },
                { value: '2', label: '2×' }
              ]}
            />
          </div>
        </div>
      )}

      {voice.speak === 'api' && (
        <div className="row">
          <div className="field">
            <label>{t('Speech model')}</label>
            <Select
              value={voice.outputModel}
              onChange={(outputModel) => set({ outputModel })}
              options={modelOptions(SPEAK_MODELS)}
            />
          </div>
          <div className="field">
            <label>{t('Voice')}</label>
            <Select
              value={voice.voiceName || 'alloy'}
              onChange={(voiceName) => set({ voiceName })}
              options={API_VOICES.map((name) => ({ value: name, label: name }))}
            />
          </div>
        </div>
      )}

      {voice.speak !== 'off' && (
        <>
          <label className="switch" style={{ marginTop: 12 }}>
            <input
              type="checkbox"
              checked={voice.autoSpeak}
              onChange={(event) => set({ autoSpeak: event.target.checked })}
            />
            {t('Read every reply automatically')}
          </label>
          <div className="hint">
            {t(
              'With this off, each reply gets a speaker button you can press. Code blocks are never read out — only the prose around them.'
            )}
          </div>

          <button
            className="btn"
            style={{ marginTop: 14 }}
            onClick={() =>
              void speak(t('This is how replies will sound.'), voice).catch(() => undefined)
            }
          >
            {t('Hear it')}
          </button>
        </>
      )}
    </>
  )
}
