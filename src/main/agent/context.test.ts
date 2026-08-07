import { describe, expect, it } from 'vitest'
import { estimateTokens, trimForContext } from './context'
import type { Message, ModelConfig } from '@shared/types'

const model: ModelConfig = {
  id: 'test',
  label: 'Test',
  contextWindow: 4_000,
  maxOutputTokens: 1_000,
  supportsTools: true,
  supportsVision: true,
  supportsThinking: false
}
const text = (role: Message['role'], value: string): Message => ({
  id: `${role}-${value.slice(0, 4)}`,
  role,
  createdAt: 0,
  content: [{ type: 'text', text: value }]
})

describe('context budgeting', () => {
  it('estimates text, tools and images', () => {
    expect(estimateTokens('system', [text('user', 'hello')])).toBe(4)
    const image: Message = {
      ...text('user', ''),
      content: [
        { type: 'image', mediaType: 'image/png', data: 'a'.repeat(100), width: 1500, height: 800 }
      ]
    }
    expect(estimateTokens('', [image])).toBeGreaterThan(4_000)
  })

  it('compacts old tool results before dropping turns', () => {
    const old: Message = {
      role: 'user',
      id: 'old',
      createdAt: 0,
      content: [
        { type: 'tool_result', toolUseId: 'x', content: 'x'.repeat(20_000), isError: false }
      ]
    }
    const padding = Array.from({ length: 7 }, (_, index) =>
      text(index % 2 ? 'assistant' : 'user', 'y'.repeat(2_000))
    )
    const result = trimForContext('system', [old, ...padding, text('user', 'current')], model, 0)
    expect(result.notice).toContain('trimmed')
  })
})
