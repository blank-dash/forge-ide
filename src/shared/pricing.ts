import type { ModelConfig, TokenUsage } from './types'

export function calculateCost(model: ModelConfig, usage: Omit<TokenUsage, 'costUsd'>): number {
  const price = model.pricing
  if (!price) return 0
  const input = Math.max(0, usage.input - usage.cacheRead - usage.cacheWrite)
  return (
    (input * price.input +
      usage.output * price.output +
      usage.reasoning * price.output +
      usage.cacheRead * (price.cacheRead ?? price.input) +
      usage.cacheWrite * (price.cacheWrite ?? price.input)) /
    1_000_000
  )
}
