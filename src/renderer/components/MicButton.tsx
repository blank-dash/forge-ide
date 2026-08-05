import { useCallback, useEffect, useRef, useState } from 'react'
import { useT } from '../i18n'
import { useStore } from '../store'
import { Recorder } from '../voice'

type Props = {
  /** Called with the transcript, to be put in the composer. */
  onText(text: string): void
}

/**
 * Dictation.
 *
 * Push-to-talk by default. Holding a key to speak and releasing to send is
 * faster and far less error-prone than a toggle you have to remember you left
 * on — but a toggle is there for anyone who would rather not hold anything.
 */
export default function MicButton({ onText }: Props) {
  const t = useT()
  const voice = useStore((state) => state.settings.voice)
  const pushError = useStore((state) => state.pushError)
  const patchUi = useStore((state) => state.patchUi)

  const recorder = useRef(new Recorder())
  const [recording, setRecording] = useState(false)
  const [working, setWorking] = useState(false)

  const start = useCallback(async () => {
    if (recording || working) return

    if (!voice.inputModel) {
      pushError('No transcription model is chosen yet — pick one under Settings → Voice.')
      patchUi({ settingsOpen: true, settingsSection: 'voice' })
      return
    }

    try {
      await recorder.current.start()
      setRecording(true)
    } catch (error) {
      pushError((error as Error).message)
    }
  }, [recording, working, voice.inputModel, pushError, patchUi])

  const finish = useCallback(async () => {
    if (!recorder.current.active) return
    setRecording(false)
    setWorking(true)

    try {
      const audio = await recorder.current.stop()
      if (!audio) return

      const result = await window.forge.voice.transcribe(
        audio.data,
        audio.mediaType,
        voice.inputLanguage
      )
      if (result.text.trim()) onText(result.text.trim())
    } catch (error) {
      pushError((error as Error).message)
    } finally {
      setWorking(false)
    }
  }, [onText, pushError, voice.inputLanguage])

  // The microphone must not be left open if this unmounts mid-recording.
  useEffect(() => {
    const active = recorder.current
    return () => active.cancel()
  }, [])

  // Escape throws the take away rather than transcribing it — the recovery
  // anyone reaches for when they realise they said the wrong thing.
  useEffect(() => {
    if (!recording) return

    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      recorder.current.cancel()
      setRecording(false)
    }

    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [recording])

  const hold = voice.pushToTalk
  const label = working
    ? t('Transcribing…')
    : recording
      ? hold
        ? t('Release to send, Esc to discard')
        : t('Click to stop, Esc to discard')
      : hold
        ? t('Hold to talk')
        : t('Click to talk')

  return (
    <button
      className={`pill mic-btn ${recording ? 'recording' : ''}`}
      title={label}
      disabled={working}
      // Pointer events, not mouse: a pen or a touchscreen holds the button too.
      onPointerDown={hold ? () => void start() : undefined}
      onPointerUp={hold ? () => void finish() : undefined}
      // Without this, dragging off the button leaves the microphone recording
      // with nothing left to release it.
      onPointerLeave={hold && recording ? () => void finish() : undefined}
      onClick={hold ? undefined : () => void (recording ? finish() : start())}
    >
      <span className="mic-glyph">{working ? '…' : recording ? '●' : '🎙'}</span>
      {recording && <span className="mic-label">{t('listening')}</span>}
    </button>
  )
}
