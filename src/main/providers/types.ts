import type {
  Message,
  ModelConfig,
  ProviderConfig,
  RateLimit,
  ReasoningEffort
} from '@shared/types'

export interface ToolSchema {
  name: string
  description: string
  /** JSON Schema object describing the tool input. */
  parameters: Record<string, unknown>
}

export interface CompletionRequest {
  provider: ProviderConfig
  model: ModelConfig
  /** Stable for the life of one conversation; provider caches key from it. */
  sessionId?: string
  system: string
  messages: Message[]
  tools: ToolSchema[]
  maxOutputTokens: number
  temperature: number
  continuation?: string
  /** Request timeouts are provider-level defaults; adapters can override them. */
  firstByteTimeoutMs?: number
  chunkTimeoutMs?: number
  /** How hard to think, as the user set it. */
  effort: ReasoningEffort
  /** Effort resolved to a token budget; 0 disables thinking entirely. */
  thinkingBudget: number
  signal: AbortSignal
}

/** Normalised stream events every adapter emits, whatever the wire format. */
export type ProviderEvent =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'thinking_signature'; signature: string }
  | { type: 'redacted_thinking'; data: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | {
      type: 'usage'
      input: number
      output: number
      cacheRead?: number
      cacheWrite?: number
      /** Thinking tokens, when the provider reports them apart from output. */
      reasoning?: number
    }
  | { type: 'limits'; limit: Omit<RateLimit, 'providerId' | 'updatedAt'> }
  | { type: 'stop'; reason: string }

/**
 * Rate-limit headers, which are the one place providers do tell you how much
 * you have left. Anthropic and OpenAI-compatible endpoints use different
 * names for the same idea; Gemini sends none.
 */
export function readRateLimit(
  headers: Headers
): Omit<RateLimit, 'providerId' | 'updatedAt'> | null {
  const num = (...names: string[]): number | undefined => {
    for (const name of names) {
      const raw = headers.get(name)
      if (raw !== null && raw !== '') {
        const value = Number(raw)
        if (Number.isFinite(value)) return value
      }
    }
    return undefined
  }

  const tokensRemaining = num(
    'anthropic-ratelimit-tokens-remaining',
    'anthropic-ratelimit-input-tokens-remaining',
    'x-ratelimit-remaining-tokens'
  )
  const tokensLimit = num(
    'anthropic-ratelimit-tokens-limit',
    'anthropic-ratelimit-input-tokens-limit',
    'x-ratelimit-limit-tokens'
  )
  const requestsRemaining = num(
    'anthropic-ratelimit-requests-remaining',
    'x-ratelimit-remaining-requests'
  )
  const resetsAt =
    headers.get('anthropic-ratelimit-tokens-reset') ??
    headers.get('x-ratelimit-reset-tokens') ??
    undefined

  if (tokensRemaining === undefined && requestsRemaining === undefined) return null
  return { tokensRemaining, tokensLimit, requestsRemaining, resetsAt: resetsAt ?? undefined }
}

export interface ProviderAdapter {
  kind: ProviderConfig['kind']
  stream(req: CompletionRequest): AsyncGenerator<ProviderEvent>
  listModels(provider: ProviderConfig, signal: AbortSignal): Promise<string[]>
}

/**
 * Applies a model's `extraBody` on top of what the adapter built. Nested plain
 * objects are merged one level deep so a user can add a single key to
 * `generationConfig` without having to restate the whole object.
 */
const PROTECTED_BODY_KEYS = new Set(['messages', 'stream', 'model', 'system', 'tools'])

export function applyExtraBody(
  body: Record<string, unknown>,
  extra: Record<string, unknown> | undefined
): Record<string, unknown> {
  if (!extra) return body

  for (const [key, value] of Object.entries(extra)) {
    if (PROTECTED_BODY_KEYS.has(key)) {
      console.warn(`[provider] ignored protected extraBody key: ${key}`)
      continue
    }
    const current = body[key]
    if (isPlainObject(current) && isPlainObject(value)) {
      body[key] = { ...current, ...value }
    } else {
      body[key] = value
    }
  }
  return body
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly detail?: string,
    readonly retryAfterMs?: number,
    readonly timeoutMs?: number
  ) {
    super(message)
    this.name = 'ProviderError'
  }
}

export function retryAfterMs(headers: Headers, now = Date.now()): number | undefined {
  const raw = headers.get('retry-after')
  if (raw) {
    const seconds = Number(raw)
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000)
    const date = Date.parse(raw)
    if (Number.isFinite(date)) return Math.max(0, date - now)
  }

  const reset = headers.get('anthropic-ratelimit-tokens-reset')
  const date = reset ? Date.parse(reset) : Number.NaN
  return Number.isFinite(date) ? Math.max(0, date - now) : undefined
}

export function retryDelay(error: unknown, attempt: number, random = Math.random): number {
  const provider = error as { status?: number; retryAfterMs?: number }
  const base =
    provider.status === 429 && provider.retryAfterMs !== undefined
      ? provider.retryAfterMs
      : 800 * 2 ** Math.max(0, attempt - 1)
  return Math.max(100, Math.round(base * (0.8 + random() * 0.4)))
}

/** Turns a non-2xx fetch response into a readable ProviderError. */
export async function toProviderError(res: Response, providerName: string): Promise<ProviderError> {
  let detail = ''
  try {
    detail = await res.text()
  } catch {
    /* body already consumed or empty */
  }

  const hint =
    res.status === 401 || res.status === 403
      ? 'Check the API key in Settings → Providers.'
      : res.status === 404
        ? 'Check the base URL and model id — the endpoint was not found.'
        : res.status === 429
          ? 'Rate limited by the provider. Wait a moment and retry.'
          : res.status >= 500
            ? 'The provider returned a server error.'
            : ''

  return new ProviderError(
    `${providerName} request failed (HTTP ${res.status}). ${hint}`.trim(),
    res.status,
    detail.slice(0, 4000),
    retryAfterMs(res.headers)
  )
}
