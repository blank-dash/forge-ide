import { describe, expect, it, vi } from 'vitest'
import { openaiAdapter } from './openai'
import type { CompletionRequest } from './types'

const request = (): CompletionRequest => ({
  provider: {
    id: 'o',
    name: 'OpenAI',
    kind: 'openai',
    baseUrl: 'https://api.openai.com/v1',
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
  sessionId: 'session-123',
  system: 'system',
  messages: [],
  tools: [],
  maxOutputTokens: 100,
  temperature: 0,
  effort: 'off',
  thinkingBudget: 0,
  signal: new AbortController().signal
})

describe('OpenAI prompt cache key', () => {
  it('sends a stable session key only to remote endpoints', async () => {
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
    const stream = openaiAdapter.stream(request())
    await stream.next()
    expect((JSON.parse(body) as { prompt_cache_key: string }).prompt_cache_key).toBe(
      'forge:session-123'
    )
    vi.unstubAllGlobals()
  })
})
