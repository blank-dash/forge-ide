import { detectsThinking, detectsVision } from '@shared/types'
import { calculateCost } from '@shared/pricing'
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

const MODEL_CACHE_TTL_MS = 6 * 60 * 60_000
const modelCache = new Map<string, { expiresAt: number; models: string[] }>()

export async function listModelsCached(
  provider: ProviderConfig,
  signal: AbortSignal,
  refresh = false
): Promise<string[]> {
  const key = `${provider.kind}:${provider.baseUrl}:${provider.apiKey}`
  const cached = modelCache.get(key)
  if (!refresh && cached && cached.expiresAt > Date.now()) return cached.models

  let lastError: unknown
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const models = await getAdapter(provider.kind).listModels(provider, signal)
      modelCache.set(key, { models, expiresAt: Date.now() + MODEL_CACHE_TTL_MS })
      return models
    } catch (error) {
      lastError = error
      if (signal.aborted) throw error
      await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** attempt))
    }
  }
  if (cached) return cached.models
  throw lastError
}

export function clearModelCache(): void {
  modelCache.clear()
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
  if (!provider)
    throw new Error(`Unknown provider "${providerId}". Add it in Settings → Providers.`)
  if (!provider.apiKey) {
    throw new Error(`No API key set for ${provider.name}. Add one in Settings → Providers.`)
  }

  const model = provider.models.find((entry) => entry.id === modelId) ?? syntheticModel(modelId)

  return { provider, model, adapter: getAdapter(provider.kind), ref }
}

/** Lets users type any model id even if it is not in the saved catalogue. */
function syntheticModel(id: string): ModelConfig {
  const thinking = detectsThinking(id)
  return {
    id,
    label: id,
    contextWindow: 128_000,
    maxOutputTokens: thinking ? 32_000 : 8_192,
    supportsTools: true,
    supportsVision: detectsVision(id),
    supportsThinking: thinking
  }
}

export function computeCost(model: ModelConfig, usage: Omit<TokenUsage, 'costUsd'>): number {
  return calculateCost(model, usage)
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
