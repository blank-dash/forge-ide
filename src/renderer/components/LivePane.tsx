import { useCallback, useEffect, useRef, useState } from 'react'
import type { LiveAction, LiveSource, LiveStatus } from '../../preload'
import { useT } from '../i18n'
import { useStore } from '../store'
import { Recorder, speak, stopSpeaking } from '../voice'

/**
 * Live mode.
 *
 * The screen goes to a model that is not on this machine, and at the higher
 * level it can click and type. So this screen is written to be read before it
 * is used: what is shared, what is allowed, and one obvious way to stop.
 */
export default function LivePane() {
  const t = useT()
  const status = useStore((state) => state.live)
  const [sources, setSources] = useState<LiveSource[]>([])
  const [picked, setPicked] = useState('')
  const [access, setAccess] = useState<'watch' | 'control'>('watch')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [preview, setPreview] = useState('')
  const [actions, setActions] = useState<LiveAction[]>([])
  const [autoStartRequested, setAutoStartRequested] = useState(false)
  const [recording, setRecording] = useState(false)
  const [transcribing, setTranscribing] = useState(false)
  const recorder = useRef(new Recorder())
  const voice = useStore((state) => state.settings.voice)
  const sessionId = useStore((state) => state.sessionId)
  const entries = useStore((state) => state.entries)
  const running = useStore((state) => state.running)
  const pushError = useStore((state) => state.pushError)
  const patchUi = useStore((state) => state.patchUi)
  const spokenReply = useRef<string | null>(null)
  const autoStarted = useRef(false)
  const autoShareStarted = useRef(false)

  useEffect(() => {
    const onStart = (event: Event): void => {
      const owner = (event as CustomEvent<string>).detail
      if (owner === sessionId) setAutoStartRequested(true)
    }
    window.addEventListener('forge:live-start', onStart)
    return () => window.removeEventListener('forge:live-start', onStart)
  }, [sessionId])

  const refreshSources = useCallback(async () => {
    try {
      const found = await window.forge.live.sources()
      setSources(found)
      setPicked((current) => current || found.find((entry) => entry.kind === 'screen')?.id || '')
    } catch (caught) {
      setError((caught as Error).message)
    }
  }, [])

  useEffect(() => {
    if (!status?.active) void refreshSources()
  }, [status?.active, refreshSources])

  useEffect(() => {
    return window.forge.live.onAction((action) => setActions((all) => [action, ...all].slice(0, 12)))
  }, [])

  useEffect(() => {
    if (!status?.active || status.sessionId !== sessionId || running || voice.speak === 'off') return
    const reply = [...entries]
      .reverse()
      .find((entry) => entry.role === 'assistant' && !entry.streaming && entry.usage)
    if (!reply) return

    const text = reply.blocks.map((block) => (block.kind === 'text' ? block.text : '')).join(' ').trim()
    if (!text || spokenReply.current === reply.id) return
    spokenReply.current = reply.id
    void speak(text).catch((caught: Error) => pushError(caught.message))
  }, [entries, running, sessionId, status?.active, status?.sessionId, voice.speak, pushError])

  useEffect(() => {
    if (!status?.active) spokenReply.current = null
  }, [status?.active])

  useEffect(() => {
    if (!status?.active) {
      autoStarted.current = false
      spokenReply.current = null
    }
  }, [status?.active])

  // The preview is what makes this honest: while a session is running you can
  // see the same frames the agent is being given.
  useEffect(() => {
    if (!status?.active) {
      setPreview('')
      return
    }

    let cancelled = false
    const tick = async (): Promise<void> => {
      const frame = await window.forge.live.frame().catch(() => '')
      if (!cancelled && frame) setPreview(frame)
    }

    void tick()
    const timer = setInterval(() => void tick(), 2000)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [status?.active])

  async function start(): Promise<void> {
    setBusy(true)
    setError(null)
    try {
      await window.forge.live.start(picked, access, sessionId ?? undefined)
      setActions([])
    } catch (caught) {
      setError((caught as Error).message)
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    if (!autoStartRequested || autoShareStarted.current || status?.active || !picked) return
    autoShareStarted.current = true
    setAutoStartRequested(false)
    void start()
  }, [autoStartRequested, picked, status?.active])

  useEffect(() => {
    return () => recorder.current.cancel()
  }, [])

  const talk = useCallback(async (): Promise<void> => {
    if (recording || transcribing) return
    if (!voice.inputModel) {
      pushError('No transcription model is chosen yet — pick one under Settings → Voice.')
      return
    }

    stopSpeaking()
    setError(null)
    try {
      await recorder.current.start(voice.inputDevice)
      setRecording(true)
    } catch (caught) {
      setError((caught as Error).message)
    }
  }, [recording, transcribing, voice.inputModel, voice.inputDevice, pushError])

  useEffect(() => {
    if (!status?.active || status.sessionId !== sessionId || autoStarted.current) return
    autoStarted.current = true
    void speak('Live mode is enabled. What shall we do?', { ...voice, speak: 'system' }).catch(() => undefined)
    void talk()
  }, [status?.active, status?.sessionId, sessionId, talk])

  const finishTalking = useCallback(async (): Promise<void> => {
    if (!recorder.current.active) return
    setRecording(false)
    setTranscribing(true)
    try {
      const audio = await recorder.current.stop()
      if (!audio) return
      const result = await window.forge.voice.transcribe(audio.data, audio.mediaType, voice.inputLanguage)
      const text = result.text.trim()
      if (!text) return

      useStore.getState().pushUser(text)
      await window.forge.agent.send(text, [], sessionId ?? undefined)
    } catch (caught) {
      const message = (caught as Error).message
      setError(message)
      pushError(message)
    } finally {
      setTranscribing(false)
    }
  }, [voice.inputLanguage, sessionId, pushError])

  const stop = async (): Promise<void> => {
    recorder.current.cancel()
    stopSpeaking()
    setRecording(false)
    await window.forge.live.stop().catch(() => undefined)
  }

  if (status?.active) {
    return (
      <div className="live">
        <header className="live-head">
          <div>
            <h1>
              <span className="live-dot" />
              {t('Sharing')} {status.sourceName}
            </h1>
            <p className="live-sub">
              {status.access === 'control'
                ? t('The agent can see this and can click and type on it.')
                : t('The agent can see this. It cannot click or type.')}
              {' · '}
              {status.actions} {t('actions so far')}
            </p>
          </div>
          <button className="btn btn-danger" onClick={() => void stop()}>
            {t('Stop sharing')}
          </button>
        </header>

        {status.controlUnavailable && (
          <div className="live-warning">{status.controlUnavailable}</div>
        )}

        <section className="live-voice" aria-live="polite">
          <div>
            <h2>{t('Talk with the agent')}</h2>
            <p>
              {recording
                ? t('Listening — tap again when you are done.')
                : transcribing
                  ? t('Transcribing your message…')
                  : voice.inputModel
                    ? t('Tap to talk. Your words are sent to the active conversation.')
                    : t('Choose a transcription model under Settings → Voice to talk.')}
            </p>
          </div>
          <button
            className={`btn ${recording ? 'btn-danger' : 'btn-primary'}`}
            disabled={transcribing}
            onClick={() => void (recording ? finishTalking() : talk())}
          >
            {transcribing ? t('Transcribing…') : recording ? t('Send voice message') : t('Talk')}
          </button>
        </section>

        {voice.speak === 'off' && (
          <div className="live-warning">
            {t('Replies are not being read aloud. Enable a computer voice under Settings → Voice.')}
          </div>
        )}

        <div className="live-preview">
          {preview ? (
            <img src={preview} alt={t('What the agent sees')} />
          ) : (
            <div className="empty-hint">{t('Waiting for the first frame…')}</div>
          )}
        </div>

        {actions.length > 0 && (
          <>
            <h2 className="live-subhead">{t('What it did')}</h2>
            <div className="live-actions">
              {actions.map((action) => (
                <div className="live-action" key={`${action.at}-${action.detail}`}>
                  <span className="live-action-kind">{action.kind}</span>
                  <span className="live-action-detail">{action.detail}</span>
                  <span className="live-action-time">{clock(action.at)}</span>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    )
  }

  return (
    <div className="live">
      <header className="live-head">
        <div>
          <h1>{t('Live mode')}</h1>
          <p className="live-sub">
            {t(
              'Share a screen or a window with the agent so it can see what you see. Frames are sent to whichever model you have configured, exactly like an image you paste — so share the thing you mean, not the whole desktop, unless you need to.'
            )}
          </p>
        </div>
      </header>

      <section className="live-voice">
        <div>
          <h2>{t('Voice conversation')}</h2>
          <p>
            {voice.inputModel
              ? t('Start sharing, then talk to the agent with the button below.')
              : t('Choose a transcription model under Settings → Voice before starting.')}
          </p>
        </div>
        <button
          className="btn"
          onClick={() => patchUi({ settingsOpen: true, settingsSection: 'voice' })}
        >
          {t('Voice settings')}
        </button>
      </section>

      {error && <div className="field-error">{error}</div>}

      <div className="field">
        <label>{t('What to share')}</label>
        <div className="live-sources">
          {sources.map((source) => (
            <button
              key={source.id}
              className={`live-source ${picked === source.id ? 'active' : ''}`}
              onClick={() => setPicked(source.id)}
            >
              {source.thumbnail ? (
                <img src={source.thumbnail} alt="" />
              ) : (
                <span className="live-source-blank" />
              )}
              <span className="live-source-name">{source.name}</span>
              <span className="live-source-kind">
                {source.kind === 'screen' ? t('screen') : t('window')}
              </span>
            </button>
          ))}
          {sources.length === 0 && <div className="empty-hint">{t('Looking for screens…')}</div>}
        </div>
        <button className="link" onClick={() => void refreshSources()}>
          {t('Refresh the list')}
        </button>
      </div>

      <div className="field">
        <label>{t('What it may do')}</label>
        <div className="live-access">
          <button
            className={`live-choice ${access === 'watch' ? 'active' : ''}`}
            onClick={() => setAccess('watch')}
          >
            <span className="live-choice-title">{t('Watch only')}</span>
            <span className="live-choice-body">
              {t('It sees the screen and nothing else. It cannot touch anything.')}
            </span>
          </button>
          <button
            className={`live-choice danger ${access === 'control' ? 'active' : ''}`}
            onClick={() => setAccess('control')}
          >
            <span className="live-choice-title">{t('Watch and control')}</span>
            <span className="live-choice-body">
              {t(
                'It can move the mouse, click and type anywhere — not only in this app. Stay at the machine.'
              )}
            </span>
          </button>
        </div>
      </div>

      {access === 'control' && (
        <div className="live-warning">
          {t(
            'Control drives the real mouse and keyboard. It can click anything that is on screen, including things this app knows nothing about. Nothing starts on its own and closing the app ends it — but while it runs, watch it.'
          )}
        </div>
      )}

      <div className="tasks-footer">
        <span style={{ flex: 1 }} />
        <button className="btn btn-primary" disabled={!picked || busy} onClick={() => void start()}>
          {access === 'control' ? t('Share and allow control') : t('Share screen')}
        </button>
      </div>
    </div>
  )
}

function clock(at: number): string {
  const date = new Date(at)
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

/** Status-bar indicator: visible from anywhere while a session is running. */
export function LiveIndicator() {
  const t = useT()
  const status = useStore((state) => state.live)
  const patchUi = useStore((state) => state.patchUi)
  const saveSettings = useStore((state) => state.saveSettings)

  if (!status?.active) return null

  return (
    <button
      className={`live-badge ${status.access === 'control' ? 'controlling' : ''}`}
      title={t('Live mode is running — click to open it')}
      onClick={() => {
        void saveSettings({ mode: 'chat' })
        patchUi({ chatPane: 'live' })
      }}
    >
      <span className="live-dot" />
      {status.access === 'control' ? t('screen + control') : t('screen shared')}
    </button>
  )
}

export type { LiveStatus }
