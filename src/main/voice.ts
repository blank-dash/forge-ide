import type { ProviderConfig, Settings } from '@shared/types'

export interface TranscribeRequest {
  data: string
  mediaType: string
  language: string
}

export interface SpeakRequest {
  text: string
  voice: string
}

const MAX_AUDIO_BYTES = 24 * 1024 * 1024

export async function transcribe(settings: Settings, request: TranscribeRequest): Promise<{ text: string }> {
  const { provider, model } = resolveVoiceModel(settings, 'input')
  const audio = Buffer.from(request.data, 'base64')
  if (!audio.byteLength) throw new Error('The recording was empty.')
  if (audio.byteLength > MAX_AUDIO_BYTES) throw new Error('That recording is too large. Record a shorter take.')

  const boundary = `----forge${Math.abs(hash(request.data.slice(0, 64))).toString(16)}`
  const parts: Buffer[] = []
  const field = (name: string, value: string): void => {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`))
  }
  field('model', model)
  if (request.language) field('language', request.language)
  field('response_format', 'text')
  parts.push(
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="speech.${extensionFor(request.mediaType)}"\r\nContent-Type: ${request.mediaType}\r\n\r\n`),
    audio,
    Buffer.from(`\r\n--${boundary}--\r\n`)
  )

  const response = await fetch(`${trimSlash(provider.baseUrl)}/audio/transcriptions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${provider.apiKey}`, 'content-type': `multipart/form-data; boundary=${boundary}`, ...provider.headers },
    body: Buffer.concat(parts)
  })
  const body = await response.text()
  if (response.status === 404) {
    const fallback = findTranscriptionFallback(settings, provider.id)
    if (fallback) return transcribe({ ...settings, voice: { ...settings.voice, inputModel: `${fallback.id}:${fallback.model}` } }, request)
    throw new Error(`${provider.name} has no transcription endpoint. Configure OpenAI/Groq Whisper or another STT provider under Settings → Voice.`)
  }
  if (!response.ok) throw new Error(`${provider.name} could not transcribe that: ${describe(response.status, body)}`)
  const text = body.trim().startsWith('{') ? extractJsonText(body) : body.trim()
  if (!text) throw new Error('Nothing was recognised in that recording.')
  return { text }
}

export async function speak(settings: Settings, request: SpeakRequest): Promise<{ data: string; mediaType: string }> {
  const { provider, model } = resolveVoiceModel(settings, 'output')
  const response = await fetch(`${trimSlash(provider.baseUrl)}/audio/speech`, {
    method: 'POST',
    headers: { authorization: `Bearer ${provider.apiKey}`, 'content-type': 'application/json', ...provider.headers },
    body: JSON.stringify({ model, voice: request.voice || 'alloy', input: request.text, response_format: 'mp3' })
  })
  if (response.status === 404) throw new Error(`${provider.name} has no speech endpoint. Use the computer's voices or configure a TTS provider under Settings → Voice.`)
  if (!response.ok) throw new Error(`${provider.name} could not speak that: ${describe(response.status, await response.text())}`)
  return { data: Buffer.from(await response.arrayBuffer()).toString('base64'), mediaType: 'audio/mpeg' }
}

function findTranscriptionFallback(settings: Settings, failedProviderId: string): { id: string; model: string } | null {
  for (const provider of settings.providers) {
    if (!provider.enabled || !provider.apiKey || provider.id === failedProviderId || provider.kind !== 'openai') continue
    const model = provider.models.find((entry) => /whisper|transcrib|speech/i.test(entry.id))
    if (model) return { id: provider.id, model: model.id }
  }
  return null
}

function resolveVoiceModel(settings: Settings, direction: 'input' | 'output'): { provider: ProviderConfig; model: string } {
  const ref = direction === 'input' ? settings.voice.inputModel : settings.voice.outputModel
  if (!ref) throw new Error(`No ${direction === 'input' ? 'transcription' : 'speech'} model is chosen. Pick one under Settings → Voice.`)
  const [providerId, ...rest] = ref.split(':')
  const provider = settings.providers.find((entry) => entry.id === providerId)
  if (!provider) throw new Error(`The provider for voice no longer exists.`)
  if (!provider.enabled || !provider.apiKey) throw new Error(`${provider.name} is not configured for voice.`)
  if (provider.kind !== 'openai') throw new Error(`${provider.name} does not offer OpenAI-compatible speech endpoints.`)
  return { provider, model: rest.join(':') }
}

function extractJsonText(body: string): string {
  try { return String((JSON.parse(body) as { text?: string }).text ?? '').trim() } catch { return '' }
}
function describe(status: number, body: string): string { return `${status} ${body.trim().slice(0, 300)}` }
function extensionFor(mediaType: string): string { return mediaType.split('/')[1]?.split(';')[0] || 'webm' }
function trimSlash(url: string): string { return url.replace(/\/+$/, '') }
function hash(value: string): number { let out = 0; for (const char of value) out = (out * 31 + char.charCodeAt(0)) | 0; return out }
