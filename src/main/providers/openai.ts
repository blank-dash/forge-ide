import type { Message, ReasoningEffort } from '@shared/types'
import { readSse, safeParse } from './sse'
import {
  applyExtraBody,
  readRateLimit,
  type CompletionRequest,
  type ProviderAdapter,
  type ProviderEvent,
  toProviderError
} from './types'

/**
 * OpenAI Chat Completions.
 *
 * This is the lingua franca: OpenRouter, Groq, DeepSeek, Together, Fireworks,
 * xAI, Mistral, Ollama, LM Studio, vLLM and llama.cpp all speak it, so any
 * such endpoint works by pointing a custom provider at its base URL.
 */
export const openaiAdapter: ProviderAdapter = {
  kind: 'openai',

  async *stream(req: CompletionRequest): AsyncGenerator<ProviderEvent> {
    const { provider, model } = req

    const body: Record<string, unknown> = {
      model: model.id,
      messages: toOpenAiMessages(req.system, req.messages),
      stream: true
    }

    // Only OpenAI itself has moved to max_completion_tokens; every other
    // OpenAI-compatible server (Ollama, LM Studio, vLLM, Groq, DeepSeek…)
    // still expects max_tokens and rejects the new name.
    const limit = Math.min(req.maxOutputTokens, model.maxOutputTokens)
    body[isOfficialOpenAi(provider.baseUrl) ? 'max_completion_tokens' : 'max_tokens'] = limit

    // Reasoning models reject any temperature other than the default.
    if (!model.supportsThinking) body.temperature = req.temperature
    else if (req.effort !== 'off') body.reasoning_effort = toReasoningEffort(req.effort)

    // Local servers frequently reject unknown fields; only ask remote ones
    // for usage accounting.
    if (!isLocal(provider.baseUrl)) {
      body.stream_options = { include_usage: true }
      if (req.sessionId) body.prompt_cache_key = `forge:${req.sessionId}`
    }

    if (req.tools.length > 0) {
      body.tools = req.tools.map((tool) => ({
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters
        }
      }))
      body.tool_choice = 'auto'
    }

    applyExtraBody(body, model.extraBody)

    const res = await fetch(`${provider.baseUrl}/chat/completions`, {
      method: 'POST',
      signal: req.signal,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${provider.apiKey}`,
        ...provider.headers
      },
      body: JSON.stringify(body)
    })

    if (!res.ok || !res.body) throw await toProviderError(res, provider.name)

    const rateLimit = readRateLimit(res.headers)
    if (rateLimit) yield { type: 'limits', limit: rateLimit }

    const calls = new Map<number, { id: string; name: string; args: string }>()
    let stopReason = 'stop'

    for await (const frame of readSse(res.body, req.chunkTimeoutMs ?? 120_000)) {
      if (frame.data === '[DONE]') break
      const chunk = safeParse<OpenAiChunk>(frame.data)
      if (!chunk) continue

      if (chunk.error) throw new Error(chunk.error.message ?? 'OpenAI stream error')

      if (chunk.usage) {
        yield {
          type: 'usage',
          input: chunk.usage.prompt_tokens ?? 0,
          output: chunk.usage.completion_tokens ?? 0,
          cacheRead: chunk.usage.prompt_tokens_details?.cached_tokens ?? 0,
          // The only evidence effort did anything: OpenAI hides the reasoning
          // text but does report how much of it there was.
          reasoning: chunk.usage.completion_tokens_details?.reasoning_tokens ?? 0
        }
      }

      const choice = chunk.choices?.[0]
      if (!choice) continue

      const delta = choice.delta
      if (delta?.content) yield { type: 'text', text: delta.content }

      // DeepSeek uses reasoning_content, OpenRouter uses reasoning.
      const reasoning = delta?.reasoning_content ?? delta?.reasoning
      if (reasoning) yield { type: 'thinking', text: reasoning }

      for (const call of delta?.tool_calls ?? []) {
        const index = call.index ?? 0
        const slot = calls.get(index) ?? { id: '', name: '', args: '' }
        if (call.id) slot.id = call.id
        if (call.function?.name) slot.name = call.function.name
        if (call.function?.arguments) slot.args += call.function.arguments
        calls.set(index, slot)
      }

      if (choice.finish_reason) stopReason = choice.finish_reason
    }

    // Chat Completions only signals tool calls as complete at end of stream.
    for (const [index, slot] of [...calls.entries()].sort((a, b) => a[0] - b[0])) {
      yield {
        type: 'tool_use',
        id: slot.id || `call_${index}`,
        name: slot.name,
        input: safeParse<Record<string, unknown>>(slot.args || '{}') ?? {}
      }
    }

    yield { type: 'stop', reason: stopReason }
  },

  async listModels(provider, signal) {
    const res = await fetch(`${provider.baseUrl}/models`, {
      signal,
      headers: { authorization: `Bearer ${provider.apiKey}`, ...provider.headers }
    })
    if (!res.ok) throw await toProviderError(res, provider.name)
    const json = (await res.json()) as { data?: Array<{ id: string }> }
    return (json.data ?? []).map((entry) => entry.id).sort()
  }
}

function isLocal(baseUrl: string): boolean {
  return /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])/i.test(baseUrl)
}

function isOfficialOpenAi(baseUrl: string): boolean {
  return /^https?:\/\/api\.openai\.com\b/i.test(baseUrl)
}

/** OpenAI tops out at "high", so max and high collapse to the same request. */
function toReasoningEffort(effort: ReasoningEffort): string {
  switch (effort) {
    case 'low':
      return 'low'
    case 'medium':
      return 'medium'
    default:
      return 'high'
  }
}

type OpenAiMessage = Record<string, unknown>

function toOpenAiMessages(system: string, messages: Message[]): OpenAiMessage[] {
  const out: OpenAiMessage[] = [{ role: 'system', content: system }]

  for (const message of messages) {
    if (message.role === 'assistant') {
      const text = message.content
        .filter((block) => block.type === 'text')
        .map((block) => (block as { text: string }).text)
        .join('')

      const toolCalls = message.content
        .filter((block) => block.type === 'tool_use')
        .map((block) => {
          const use = block as { id: string; name: string; input: unknown }
          return {
            id: use.id,
            type: 'function',
            function: { name: use.name, arguments: JSON.stringify(use.input ?? {}) }
          }
        })

      if (!text && toolCalls.length === 0) continue
      const entry: OpenAiMessage = { role: 'assistant', content: text || null }
      if (toolCalls.length > 0) entry.tool_calls = toolCalls
      out.push(entry)
      continue
    }

    // User turn: tool results must be emitted as standalone `tool` messages.
    const parts: Array<Record<string, unknown>> = []
    for (const block of message.content) {
      if (block.type === 'tool_result') {
        out.push({
          role: 'tool',
          tool_call_id: block.toolUseId,
          content: block.content || '(no output)'
        })
      } else if (block.type === 'text' && block.text.trim()) {
        parts.push({ type: 'text', text: block.text })
      } else if (block.type === 'image') {
        parts.push({
          type: 'image_url',
          image_url: { url: `data:${block.mediaType};base64,${block.data}` }
        })
      }
    }

    if (parts.length === 1 && parts[0].type === 'text') {
      out.push({ role: 'user', content: parts[0].text })
    } else if (parts.length > 0) {
      out.push({ role: 'user', content: parts })
    }
  }

  return out
}

interface OpenAiChunk {
  choices?: Array<{
    delta?: {
      content?: string
      reasoning?: string
      reasoning_content?: string
      tool_calls?: Array<{
        index?: number
        id?: string
        function?: { name?: string; arguments?: string }
      }>
    }
    finish_reason?: string
  }>
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    prompt_tokens_details?: { cached_tokens?: number }
    completion_tokens_details?: { reasoning_tokens?: number }
  }
  error?: { message?: string }
}
