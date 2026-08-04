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
  system: string
  messages: Message[]
  tools: ToolSchema[]
  maxOutputTokens: number
  temperature: number
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
export function readRateLimit(headers: Headers): Omit<RateLimit, 'providerId' | 'updatedAt'> | null {
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
export function applyExtraBody(
  body: Record<string, unknown>,
  extra: Record<string, unknown> | undefined
): Record<string, unknown> {
  if (!extra) return body

  for (const [key, value] of Object.entries(extra)) {
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
    readonly detail?: string
  ) {
    super(message)
    this.name = 'ProviderError'
  }
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
    detail.slice(0, 4000)
  )
}
