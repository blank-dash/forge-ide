import { describe, expect, it, vi } from 'vitest'
import { anthropicAdapter } from './anthropic'
import type { CompletionRequest } from './types'

const request = (): CompletionRequest => ({
  provider: {
    id: 'a',
    name: 'A',
    kind: 'anthropic',
    baseUrl: 'https://example.com',
    apiKey: 'key',
    headers: {},
    models: [],
    builtin: false,
    enabled: true
  },
  model: {
    id: 'model',
    label: 'Model',
    contextWindow: 1000,
    maxOutputTokens: 100,
    supportsTools: true,
    supportsVision: false,
    supportsThinking: false
  },
  system: 'stable system',
  messages: [],
  tools: [{ name: 'read_file', description: 'read', parameters: {} }],
  maxOutputTokens: 100,
  temperature: 0,
  effort: 'off',
  thinkingBudget: 0,
  signal: new AbortController().signal
})

describe('Anthropic prompt caching', () => {
  it('marks stable system and final tool prefix for caching', async () => {
    let body = ''
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.close()
        }
      }),
      { status: 200, headers: { 'content-type': 'text/event-stream' } }
    )
    vi.stubGlobal('fetch', async (_input: unknown, init?: RequestInit) => {
      body = String(init?.body)
      return response
    })
    const stream = anthropicAdapter.stream(request())
    await stream.next()
    const parsed = JSON.parse(body) as {
      system: Array<{ cache_control?: unknown }>
      tools: Array<{ cache_control?: unknown }>
    }
    expect(parsed.system[0].cache_control).toEqual({ type: 'ephemeral' })
    expect(parsed.tools[0].cache_control).toEqual({ type: 'ephemeral' })
    vi.unstubAllGlobals()
  })
})
