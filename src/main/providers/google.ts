import type { Message } from '@shared/types'
import { readSse, safeParse } from './sse'
import {
  applyExtraBody,
  type CompletionRequest,
  type ProviderAdapter,
  type ProviderEvent,
  toProviderError
} from './types'

/** Google Gemini generateContent API (also covers Vertex-compatible proxies). */
export const googleAdapter: ProviderAdapter = {
  kind: 'google',

  async *stream(req: CompletionRequest): AsyncGenerator<ProviderEvent> {
    const { provider, model } = req

    const generationConfig: Record<string, unknown> = {
      temperature: req.temperature,
      maxOutputTokens: Math.min(req.maxOutputTokens, model.maxOutputTokens)
    }
    if (req.thinkingBudget > 0 && model.supportsThinking) {
      generationConfig.thinkingConfig = {
        thinkingBudget: req.thinkingBudget,
        includeThoughts: true
      }
    }

    const body: Record<string, unknown> = {
      systemInstruction: { parts: [{ text: req.system }] },
      contents: toGeminiContents(req.messages),
      generationConfig
    }

    if (req.tools.length > 0) {
      body.tools = [
        {
          functionDeclarations: req.tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            parameters: sanitizeSchema(tool.parameters)
          }))
        }
      ]
    }

    applyExtraBody(body, model.extraBody)

    const url = `${provider.baseUrl}/models/${encodeURIComponent(model.id)}:streamGenerateContent?alt=sse`
    const res = await fetch(url, {
      method: 'POST',
      signal: req.signal,
      headers: {
        'content-type': 'application/json',
        'x-goog-api-key': provider.apiKey,
        ...provider.headers
      },
      body: JSON.stringify(body)
    })

    if (!res.ok || !res.body) throw await toProviderError(res, provider.name)

    let stopReason = 'stop'
    let callSeq = 0

    for await (const frame of readSse(res.body)) {
      const chunk = safeParse<GeminiChunk>(frame.data)
      if (!chunk) continue
      if (chunk.error) throw new Error(chunk.error.message ?? 'Gemini stream error')

      if (chunk.usageMetadata) {
        yield {
          type: 'usage',
          input: chunk.usageMetadata.promptTokenCount ?? 0,
          output:
            (chunk.usageMetadata.candidatesTokenCount ?? 0) +
            (chunk.usageMetadata.thoughtsTokenCount ?? 0),
          cacheRead: chunk.usageMetadata.cachedContentTokenCount ?? 0
        }
      }

      const candidate = chunk.candidates?.[0]
      if (!candidate) continue
      if (candidate.finishReason) stopReason = candidate.finishReason

      for (const part of candidate.content?.parts ?? []) {
        if (part.functionCall) {
          yield {
            type: 'tool_use',
            id: `gemini_${callSeq++}_${part.functionCall.name}`,
            name: part.functionCall.name,
            input: (part.functionCall.args ?? {}) as Record<string, unknown>
          }
        } else if (typeof part.text === 'string' && part.text.length > 0) {
          yield part.thought
            ? { type: 'thinking', text: part.text }
            : { type: 'text', text: part.text }
        }
      }
    }

    yield { type: 'stop', reason: stopReason }
  },

  async listModels(provider, signal) {
    const res = await fetch(`${provider.baseUrl}/models?pageSize=200`, {
      signal,
      headers: { 'x-goog-api-key': provider.apiKey, ...provider.headers }
    })
    if (!res.ok) throw await toProviderError(res, provider.name)
    const json = (await res.json()) as { models?: Array<{ name: string }> }
    return (json.models ?? []).map((entry) => entry.name.replace(/^models\//, '')).sort()
  }
}

function toGeminiContents(messages: Message[]): unknown[] {
  // Gemini addresses function responses by name, not by call id, so we need a
  // lookup built from the tool_use blocks we already sent.
  const nameByToolId = new Map<string, string>()
  for (const message of messages) {
    for (const block of message.content) {
      if (block.type === 'tool_use') nameByToolId.set(block.id, block.name)
    }
  }

  const contents: unknown[] = []

  for (const message of messages) {
    const parts: unknown[] = []

    for (const block of message.content) {
      switch (block.type) {
        case 'text':
          if (block.text.trim()) parts.push({ text: block.text })
          break
        case 'tool_use':
          parts.push({ functionCall: { name: block.name, args: block.input ?? {} } })
          break
        case 'tool_result':
          parts.push({
            functionResponse: {
              name: nameByToolId.get(block.toolUseId) ?? 'tool',
              response: { output: block.content || '(no output)', error: block.isError }
            }
          })
          break
        case 'image':
          parts.push({ inlineData: { mimeType: block.mediaType, data: block.data } })
          break
        case 'thinking':
          break
      }
    }

    if (parts.length > 0) {
      contents.push({ role: message.role === 'assistant' ? 'model' : 'user', parts })
    }
  }

  return contents
}

/** Gemini accepts only a subset of JSON Schema; unknown keys hard-fail. */
const ALLOWED_SCHEMA_KEYS = new Set([
  'type',
  'format',
  'description',
  'nullable',
  'enum',
  'items',
  'properties',
  'required',
  'minimum',
  'maximum'
])

function sanitizeSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(sanitizeSchema)
  if (!schema || typeof schema !== 'object') return schema

  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(schema as Record<string, unknown>)) {
    if (!ALLOWED_SCHEMA_KEYS.has(key)) continue
    if (key === 'type' && typeof value === 'string') {
      // Gemini's Schema.type is a proto enum; its JSON names are upper case.
      out[key] = value.toUpperCase()
    } else if (key === 'properties' && value && typeof value === 'object') {
      const props: Record<string, unknown> = {}
      for (const [name, prop] of Object.entries(value as Record<string, unknown>)) {
        props[name] = sanitizeSchema(prop)
      }
      out[key] = props
    } else if (key === 'items') {
      out[key] = sanitizeSchema(value)
    } else {
      out[key] = value
    }
  }
  return out
}

interface GeminiChunk {
  candidates?: Array<{
    content?: {
      parts?: Array<{
        text?: string
        thought?: boolean
        functionCall?: { name: string; args?: unknown }
      }>
    }
    finishReason?: string
  }>
  usageMetadata?: {
    promptTokenCount?: number
    candidatesTokenCount?: number
    thoughtsTokenCount?: number
    cachedContentTokenCount?: number
  }
  error?: { message?: string }
}
