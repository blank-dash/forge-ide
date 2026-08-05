import type { ProviderConfig, Settings } from '@shared/types'

/**
 * Speech, both directions, through whichever provider you already configured.
 *
 * No bundled model and no separate account: transcription posts to the same
 * OpenAI-shaped endpoint that OpenAI, Groq, a local Ollama or anything else
 * compatible already exposes, using the key that is already stored. The app
 * stays "bring your own model" for speech too.
 *
 * Speaking aloud defaults to the operating system's own voices instead, which
 * cost nothing, work offline, and start instantly — the API path exists for
 * when that is not good enough.
 */

export interface TranscribeRequest {
  /** Base64 audio, no data: prefix. */
  data: string
  /** e.g. "audio/webm" — what MediaRecorder produced. */
  mediaType: string
  /** Hint for the recogniser, e.g. "ru". Empty lets it decide. */
  language: string
}

export interface SpeakRequest {
  text: string
  voice: string
}

const MAX_AUDIO_BYTES = 24 * 1024 * 1024

/**
 * Turns recorded audio into text.
 *
 * Multipart is assembled by hand because the body has to be a Buffer with an
 * exact boundary; FormData in a main-process fetch would stream a Blob the
 * providers reject.
 */
export async function transcribe(
  settings: Settings,
  request: TranscribeRequest
): Promise<{ text: string }> {
  const { provider, model } = resolveVoiceModel(settings, 'input')

  const audio = Buffer.from(request.data, 'base64')
  if (audio.byteLength === 0) throw new Error('The recording was empty.')
  if (audio.byteLength > MAX_AUDIO_BYTES) {
    throw new Error(
      `That recording is ${(audio.byteLength / 1e6).toFixed(1)} MB, which is more than the ` +
        'transcription endpoint accepts. Record in shorter takes.'
    )
  }

  const boundary = `----forge${Math.abs(hash(request.data.slice(0, 64))).toString(16)}`
  const parts: Buffer[] = []

  const field = (name: string, value: string): void => {
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`
      )
    )
  }

  field('model', model)
  if (request.language) field('language', request.language)
  // Text, not JSON: every compatible endpoint returns the transcript directly
  // for this format, while the JSON shapes differ between them.
  field('response_format', 'text')

  parts.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; ` +
        `filename="speech.${extensionFor(request.mediaType)}"\r\n` +
        `Content-Type: ${request.mediaType}\r\n\r\n`
    ),
    audio,
    Buffer.from(`\r\n--${boundary}--\r\n`)
  )

  const response = await fetch(`${trimSlash(provider.baseUrl)}/audio/transcriptions`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${provider.apiKey}`,
      'content-type': `multipart/form-data; boundary=${boundary}`,
      ...provider.headers
    },
    body: Buffer.concat(parts)
  })

  const body = await response.text()
  if (response.status === 404) {
    // Being OpenAI-shaped for chat does not mean having the audio endpoints.
    // Most gateways and local servers implement /chat/completions and nothing
    // else, and a bare "404 page not found" gives no hint of that.
    throw new Error(
      `${provider.name} has no transcription endpoint — ${trimSlash(provider.baseUrl)}` +
        '/audio/transcriptions does not exist. Speaking to it needs a provider that offers ' +
        'speech-to-text: OpenAI, Groq, or a local server that implements it. Pick one under ' +
        'Settings → Voice.'
    )
  }
  if (!response.ok) {
    throw new Error(`${provider.name} could not transcribe that: ${describe(response.status, body)}`)
  }

  // 'text' format gives the transcript raw, but some gateways answer with JSON
  // regardless of what was asked for.
  const text = body.trim().startsWith('{') ? extractJsonText(body) : body.trim()
  if (!text) throw new Error('Nothing was recognised in that recording.')
  return { text }
}

/** Turns text into speech. Returns base64 audio and its type. */
export async function speak(
  settings: Settings,
  request: SpeakRequest
): Promise<{ data: string; mediaType: string }> {
  const { provider, model } = resolveVoiceModel(settings, 'output')

  const response = await fetch(`${trimSlash(provider.baseUrl)}/audio/speech`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${provider.apiKey}`,
      'content-type': 'application/json',
      ...provider.headers
    },
    body: JSON.stringify({
      model,
      voice: request.voice || 'alloy',
      input: request.text,
      response_format: 'mp3'
    })
  })

  if (response.status === 404) {
    throw new Error(
      `${provider.name} has no speech endpoint — ${trimSlash(provider.baseUrl)}/audio/speech does ` +
        "not exist. Use this computer's voices instead, or choose a provider that offers " +
        'text-to-speech.'
    )
  }
  if (!response.ok) {
    const body = await response.text()
    throw new Error(`${provider.name} could not speak that: ${describe(response.status, body)}`)
  }

  const audio = Buffer.from(await response.arrayBuffer())
  return { data: audio.toString('base64'), mediaType: 'audio/mpeg' }
}

/* ------------------------------------------------------------------ */

function resolveVoiceModel(
  settings: Settings,
  direction: 'input' | 'output'
): { provider: ProviderConfig; model: string } {
  const ref = direction === 'input' ? settings.voice.inputModel : settings.voice.outputModel
  const what = direction === 'input' ? 'transcription' : 'speech'

  if (!ref) {
    throw new Error(`No ${what} model is chosen. Pick one under Settings → Voice.`)
  }

  const [providerId, ...rest] = ref.split(':')
  const provider = settings.providers.find((entry) => entry.id === providerId)
  if (!provider) throw new Error(`The provider for ${what} ("${providerId}") no longer exists.`)
  if (!provider.enabled) throw new Error(`${provider.name} is switched off.`)
  if (!provider.apiKey) throw new Error(`${provider.name} has no API key.`)

  // Anthropic and Google have no speech endpoints at all; sending there would
  // produce a puzzling 404 rather than a useful message.
  if (provider.kind !== 'openai') {
    throw new Error(
      `${provider.name} does not offer ${what}. Choose an OpenAI-compatible provider — OpenAI, ` +
        'Groq, or a local server that speaks the same API.'
    )
  }

  return { provider, model: rest.join(':') }
}

function extractJsonText(body: string): string {
  try {
    const parsed = JSON.parse(body) as { text?: string; error?: { message?: string } }
    if (parsed.error?.message) throw new Error(parsed.error.message)
    return (parsed.text ?? '').trim()
  } catch {
    return ''
  }
}

function describe(status: number, body: string): string {
  const trimmed = body.trim()
  try {
    const parsed = JSON.parse(trimmed) as { error?: { message?: string } }
    if (parsed.error?.message) return parsed.error.message
  } catch {
    // Not JSON; the raw body is more useful than nothing.
  }
  return `${status} ${trimmed.slice(0, 300)}`
}

/** Providers pick their decoder from the filename, so it has to be right. */
function extensionFor(mediaType: string): string {
  const base = mediaType.split(';')[0].trim().toLowerCase()
  switch (base) {
    case 'audio/webm':
      return 'webm'
    case 'audio/ogg':
      return 'ogg'
    case 'audio/mp4':
    case 'audio/x-m4a':
      return 'm4a'
    case 'audio/mpeg':
      return 'mp3'
    case 'audio/wav':
    case 'audio/x-wav':
      return 'wav'
    default:
      return 'webm'
  }
}

function trimSlash(url: string): string {
  return url.replace(/\/+$/, '')
}

function hash(value: string): number {
  let out = 0
  for (let index = 0; index < value.length; index++) {
    out = (out * 31 + value.charCodeAt(index)) | 0
  }
  return out
}
