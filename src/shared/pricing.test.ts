import { describe, expect, it } from 'vitest'
import { calculateCost } from './pricing'
import type { ModelConfig } from './types'

const model: ModelConfig = {
  id: 'priced',
  label: 'Priced',
  contextWindow: 1000,
  maxOutputTokens: 100,
  supportsTools: true,
  supportsVision: false,
  supportsThinking: true,
  pricing: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 }
}

describe('calculateCost', () => {
  it('prices reasoning as output and cache at its own rates', () => {
    const cost = calculateCost(model, {
      input: 1000,
      output: 100,
      reasoning: 50,
      cacheRead: 200,
      cacheWrite: 100
    })
    expect(cost).toBeCloseTo((700 * 2 + 100 * 10 + 50 * 10 + 200 * 0.2 + 100 * 2.5) / 1_000_000)
  })

  it('returns zero for an unpriced model', () => {
    expect(
      calculateCost(
        { ...model, pricing: undefined },
        { input: 1, output: 1, reasoning: 1, cacheRead: 0, cacheWrite: 0 }
      )
    ).toBe(0)
  })
})
