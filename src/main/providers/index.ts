import type {
  ModelConfig,
  ModelRef,
  ProviderConfig,
  ProviderTestResult,
  Settings,
  TokenUsage
} from '@shared/types'
import { anthropicAdapter } from './anthropic'
import { googleAdapter } from './google'
import { openaiAdapter } from './openai'
import type { ProviderAdapter } from './types'

const ADAPTERS: Record<ProviderConfig['kind'], ProviderAdapter> = {
  anthropic: anthropicAdapter,
  openai: openaiAdapter,
  google: googleAdapter
}

export function getAdapter(kind: ProviderConfig['kind']): ProviderAdapter {
  const adapter = ADAPTERS[kind]
  if (!adapter) throw new Error(`Unsupported provider kind: ${kind}`)
  return adapter
}

export interface ResolvedModel {
  provider: ProviderConfig
  model: ModelConfig
  adapter: ProviderAdapter
  ref: ModelRef
}

/**
 * Resolves `${providerId}:${modelId}`. The model id may itself contain colons
 * (Ollama tags like `qwen2.5-coder:14b`), so we split on the first one only.
 */
export function resolveModel(settings: Settings, ref: ModelRef): ResolvedModel {
  const sep = ref.indexOf(':')
  if (sep === -1) throw new Error(`Malformed model reference: "${ref}"`)

  const providerId = ref.slice(0, sep)
  const modelId = ref.slice(sep + 1)

  const provider = settings.providers.find((entry) => entry.id === providerId)
  if (!provider) throw new Error(`Unknown provider "${providerId}". Add it in Settings → Providers.`)
  if (!provider.apiKey) {
    throw new Error(`No API key set for ${provider.name}. Add one in Settings → Providers.`)
  }

  const model =
    provider.models.find((entry) => entry.id === modelId) ?? syntheticModel(modelId)

  return { provider, model, adapter: getAdapter(provider.kind), ref }
}

/** Lets users type any model id even if it is not in the saved catalogue. */
function syntheticModel(id: string): ModelConfig {
  return {
    id,
    label: id,
    contextWindow: 128_000,
    maxOutputTokens: 8_192,
    supportsTools: true,
    supportsVision: false,
    supportsThinking: false
  }
}

export function computeCost(model: ModelConfig, usage: Omit<TokenUsage, 'costUsd'>): number {
  const pricing = model.pricing
  if (!pricing) return 0
  const million = 1_000_000
  return (
    (usage.input * pricing.input) / million +
    (usage.output * pricing.output) / million +
    (usage.cacheRead * (pricing.cacheRead ?? pricing.input * 0.1)) / million +
    (usage.cacheWrite * (pricing.cacheWrite ?? pricing.input * 1.25)) / million
  )
}

/** Round-trips a tiny request so the user gets a real answer, not a guess. */
export async function testProvider(provider: ProviderConfig): Promise<ProviderTestResult> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 20_000)
  const started = Date.now()

  try {
    const adapter = getAdapter(provider.kind)
    const models = await adapter.listModels(provider, controller.signal)
    return {
      ok: true,
      message: `Connected. ${models.length} model${models.length === 1 ? '' : 's'} available.`,
      latencyMs: Date.now() - started,
      models
    }
  } catch (error) {
    const err = error as Error & { detail?: string }
    return {
      ok: false,
      message: err.detail ? `${err.message}\n${err.detail.slice(0, 500)}` : err.message,
      latencyMs: Date.now() - started
    }
  } finally {
    clearTimeout(timer)
  }
}

export { ProviderError } from './types'
export type { CompletionRequest, ProviderEvent, ToolSchema } from './types'
