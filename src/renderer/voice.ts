import { forSpeech } from '@shared/speech'
import type { VoiceSettings } from '@shared/types'
import { useStore } from './store'

/**
 * Speech in the renderer.
 *
 * Recording lives here because the microphone is a page capability, not a
 * main-process one. Transcription itself does not: the audio is handed over the
 * bridge so the API key never reaches a page.
 *
 * Speaking aloud uses the operating system's own voices by default. They are
 * free, work with no network, and start speaking immediately — which for
 * reading a reply back matters more than the extra polish of a paid voice.
 */

export class Recorder {
  private recorder: MediaRecorder | null = null
  private chunks: Blob[] = []
  private stream: MediaStream | null = null

  get active(): boolean {
    return this.recorder?.state === 'recording'
  }

  async start(deviceId?: string): Promise<void> {
    if (this.active) return

    this.stream = await navigator.mediaDevices
      .getUserMedia({
        audio: {
          // `exact` would fail outright when a headset is unplugged between
          // sessions; a plain id falls back to the default device instead.
          ...(deviceId ? { deviceId } : {}),
          // Speech, not music: these three make a laptop microphone in a room
          // with a fan usable, and the recogniser is far more accurate for it.
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        }
      })
      .catch((error: Error) => {
        throw new Error(
          error.name === 'NotAllowedError'
            ? 'Microphone access was refused. Allow it for Forge and try again.'
            : `No microphone available: ${error.message}`
        )
      })

    this.chunks = []
    this.recorder = new MediaRecorder(this.stream, { mimeType: pickMimeType() })
    this.recorder.addEventListener('dataavailable', (event) => {
      if (event.data.size > 0) this.chunks.push(event.data)
    })
    this.recorder.start()
  }

  /** Stops and returns what was recorded, or null if it was silence. */
  async stop(): Promise<{ data: string; mediaType: string } | null> {
    const recorder = this.recorder
    if (!recorder || recorder.state === 'inactive') {
      this.release()
      return null
    }

    const finished = new Promise<void>((resolve) => {
      recorder.addEventListener('stop', () => resolve(), { once: true })
    })
    recorder.stop()
    await finished
    this.release()

    if (this.chunks.length === 0) return null
    const blob = new Blob(this.chunks, { type: recorder.mimeType })
    // Under about a tenth of a second is a mis-click, not speech.
    if (blob.size < 2000) return null

    return { data: await toBase64(blob), mediaType: recorder.mimeType }
  }

  /** Throws the recording away and releases the microphone. */
  cancel(): void {
    if (this.recorder && this.recorder.state !== 'inactive') this.recorder.stop()
    this.chunks = []
    this.release()
  }

  /**
   * The microphone indicator in the title bar stays lit until every track is
   * stopped, so this has to run on every path out — including cancellation.
   */
  private release(): void {
    for (const track of this.stream?.getTracks() ?? []) track.stop()
    this.stream = null
    this.recorder = null
  }
}

/* ------------------------------------------------------------------ */

let audio: HTMLAudioElement | null = null
/** Set while the system synthesiser is mid-sentence, which it cannot report. */
let systemSpeaking = false

/**
 * Reads text aloud, by whichever route the settings choose.
 *
 * `using` exists for the settings pane's preview button, which has to speak
 * with the choices on screen rather than the ones last saved — otherwise
 * picking a voice and pressing preview demonstrates the previous voice.
 */
export async function speak(text: string, using?: VoiceSettings): Promise<void> {
  const voice = using ?? useStore.getState().settings.voice
  const clean = forSpeech(text)
  if (voice.speak === 'off' || !clean) return

  stopSpeaking()

  if (voice.speak === 'api') {
    const spoken = await window.forge.voice.speak(clean, voice.voiceName)
    audio = new Audio(`data:${spoken.mediaType};base64,${spoken.data}`)
    await audio.play()
    return
  }

  // Through the main process, not `speechSynthesis`. Chromium's speech API is
  // backed by a service Electron does not ship: in here it reports no voices
  // and speaks nothing, without an error to say so.
  systemSpeaking = true
  try {
    await window.forge.voice.say(clean, voice.voiceName, voice.rate || 1)
  } finally {
    systemSpeaking = false
  }
}

export function stopSpeaking(): void {
  if (systemSpeaking) {
    void window.forge.voice.hush()
    systemSpeaking = false
  }
  if (audio) {
    audio.pause()
    audio = null
  }
}

export function isSpeaking(): boolean {
  return systemSpeaking || (audio !== null && !audio.paused)
}

/**
 * Microphones this machine has.
 *
 * Labels are hidden until permission has been granted at least once, so this
 * asks for it first — otherwise the picker shows a list of blank entries.
 */
export async function microphones(): Promise<MediaDeviceInfo[]> {
  try {
    const probe = await navigator.mediaDevices.getUserMedia({ audio: true })
    for (const track of probe.getTracks()) track.stop()
  } catch {
    // Refused: the list will have ids but no names, which is still usable.
  }

  const devices = await navigator.mediaDevices.enumerateDevices().catch(() => [])
  return devices.filter((device) => device.kind === 'audioinput')
}

/** Voices installed on this machine. */
export function systemVoices(): Promise<Array<{ name: string; lang: string }>> {
  return window.forge.voice.voices().catch(() => [])
}

/* ------------------------------------------------------------------ */

/** The first container this build can actually record. */
function pickMimeType(): string {
  const wanted = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4']
  return wanted.find((type) => MediaRecorder.isTypeSupported(type)) ?? ''
}

function toBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(new Error('Could not read the recording.'))
    reader.onload = () => {
      const result = String(reader.result)
      resolve(result.slice(result.indexOf(',') + 1))
    }
    reader.readAsDataURL(blob)
  })
}
