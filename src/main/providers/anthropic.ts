import type { ContentBlock, Message } from '@shared/types'
import { readSse, safeParse } from './sse'
import {
  applyExtraBody,
  type CompletionRequest,
  type ProviderAdapter,
  type ProviderEvent,
  toProviderError
} from './types'

const API_VERSION = '2023-06-01'

/** Anthropic Messages API — also matches Bedrock/Vertex proxies and LiteLLM. */
export const anthropicAdapter: ProviderAdapter = {
  kind: 'anthropic',

  async *stream(req: CompletionRequest): AsyncGenerator<ProviderEvent> {
    const { provider, model } = req
    const thinkingOn = req.thinkingBudget > 0 && model.supportsThinking

    const body: Record<string, unknown> = {
      model: model.id,
      max_tokens: Math.min(req.maxOutputTokens, model.maxOutputTokens),
      system: req.system,
      messages: req.messages.map(toAnthropicMessage).filter((msg) => msg.content.length > 0),
      stream: true
    }

    if (req.tools.length > 0) {
      body.tools = req.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.parameters
      }))
    }

    if (thinkingOn) {
      // Thinking requires max_tokens > budget and forbids temperature.
      body.thinking = { type: 'enabled', budget_tokens: req.thinkingBudget }
      body.max_tokens = Math.max(
        req.thinkingBudget + 4096,
        body.max_tokens as number
      )
    } else {
      body.temperature = req.temperature
    }

    applyExtraBody(body, model.extraBody)

    const res = await fetch(`${provider.baseUrl}/v1/messages`, {
      method: 'POST',
      signal: req.signal,
      headers: {
        'content-type': 'application/json',
        'x-api-key': provider.apiKey,
        'anthropic-version': API_VERSION,
        ...provider.headers
      },
      body: JSON.stringify(body)
    })

    if (!res.ok || !res.body) throw await toProviderError(res, provider.name)

    // tool_use inputs arrive as a stream of partial JSON fragments keyed by
    // content block index; buffer them until content_block_stop.
    const pending = new Map<number, { id: string; name: string; json: string }>()

    for await (const frame of readSse(res.body)) {
      const evt = safeParse<AnthropicStreamEvent>(frame.data)
      if (!evt) continue

      switch (evt.type) {
        case 'content_block_start': {
          const block = evt.content_block
          if (block?.type === 'tool_use') {
            pending.set(evt.index, { id: block.id, name: block.name, json: '' })
          }
          break
        }

        case 'content_block_delta': {
          const delta = evt.delta
          if (!delta) break
          if (delta.type === 'text_delta' && delta.text) {
            yield { type: 'text', text: delta.text }
          } else if (delta.type === 'thinking_delta' && delta.thinking) {
            yield { type: 'thinking', text: delta.thinking }
          } else if (delta.type === 'input_json_delta') {
            const slot = pending.get(evt.index)
            if (slot) slot.json += delta.partial_json ?? ''
          }
          break
        }

        case 'content_block_stop': {
          const slot = pending.get(evt.index)
          if (slot) {
            pending.delete(evt.index)
            yield {
              type: 'tool_use',
              id: slot.id,
              name: slot.name,
              input: safeParse<Record<string, unknown>>(slot.json || '{}') ?? {}
            }
          }
          break
        }

        case 'message_start': {
          const usage = evt.message?.usage
          if (usage) {
            yield {
              type: 'usage',
              input: usage.input_tokens ?? 0,
              output: usage.output_tokens ?? 0,
              cacheRead: usage.cache_read_input_tokens ?? 0,
              cacheWrite: usage.cache_creation_input_tokens ?? 0
            }
          }
          break
        }

        case 'message_delta': {
          if (evt.usage?.output_tokens != null) {
            yield { type: 'usage', input: 0, output: evt.usage.output_tokens }
          }
          if (evt.delta?.stop_reason) {
            yield { type: 'stop', reason: evt.delta.stop_reason }
          }
          break
        }

        case 'error':
          throw new Error(evt.error?.message ?? 'Anthropic stream error')
      }
    }
  },

  async listModels(provider, signal) {
    const res = await fetch(`${provider.baseUrl}/v1/models?limit=1000`, {
      signal,
      headers: {
        'x-api-key': provider.apiKey,
        'anthropic-version': API_VERSION,
        ...provider.headers
      }
    })
    if (!res.ok) throw await toProviderError(res, provider.name)
    const json = (await res.json()) as { data?: Array<{ id: string }> }
    return (json.data ?? []).map((entry) => entry.id)
  }
}

function toAnthropicMessage(message: Message) {
  return {
    role: message.role,
    content: message.content.flatMap(toAnthropicBlock)
  }
}

function toAnthropicBlock(block: ContentBlock): unknown[] {
  switch (block.type) {
    case 'text':
      return block.text.trim() ? [{ type: 'text', text: block.text }] : []
    case 'tool_use':
      return [{ type: 'tool_use', id: block.id, name: block.name, input: block.input }]
    case 'tool_result':
      return [
        {
          type: 'tool_result',
          tool_use_id: block.toolUseId,
          content: block.content || '(no output)',
          is_error: block.isError
        }
      ]
    case 'image':
      return [
        {
          type: 'image',
          source: { type: 'base64', media_type: block.mediaType, data: block.data }
        }
      ]
    // Thinking blocks are dropped from history: replaying them requires the
    // original cryptographic signature, which we do not persist.
    case 'thinking':
      return []
  }
}

interface AnthropicStreamEvent {
  type: string
  index: number
  content_block?: { type: string; id: string; name: string }
  delta?: {
    type?: string
    text?: string
    thinking?: string
    partial_json?: string
    stop_reason?: string
  }
  message?: { usage?: AnthropicUsage }
  usage?: AnthropicUsage
  error?: { message?: string }
}

interface AnthropicUsage {
  input_tokens?: number
  output_tokens?: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
}
