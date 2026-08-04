import type { ContentBlock, Message, ModelConfig } from '@shared/types'
import { DEFAULT_CONTEXT_THRESHOLD } from '@shared/defaults'

/**
 * Characters per token. Deliberately conservative — over-estimating costs a
 * little headroom, under-estimating costs a hard 400 from the provider in the
 * middle of a long session.
 */
const CHARS_PER_TOKEN = 3.4

/** Tool results older than this many messages get compacted first. */
const RECENT_WINDOW = 6
const COMPACTED_TOOL_RESULT_CHARS = 400

export interface TrimResult {
  messages: Message[]
  /** Set when anything was dropped, so the UI can say so. */
  notice: string | null
  estimatedTokens: number
}

export function estimateTokens(system: string, messages: Message[]): number {
  let chars = system.length
  for (const message of messages) {
    for (const block of message.content) chars += blockSize(block)
  }
  return Math.ceil(chars / CHARS_PER_TOKEN)
}

/**
 * Keeps the conversation inside the model's context window.
 *
 * Two stages, cheapest first: shrink the bodies of old tool results (which are
 * almost always the bulk of a coding session), and only then drop whole turns
 * from the front. Dropping always stops on a clean user turn so the
 * assistant/tool-result pairing every provider validates stays intact.
 */
export function trimForContext(
  system: string,
  messages: Message[],
  model: ModelConfig,
  reservedForOutput: number
): TrimResult {
  const threshold = model.contextThreshold ?? DEFAULT_CONTEXT_THRESHOLD
  const budget = Math.max(
    4_000,
    Math.floor(model.contextWindow * threshold) - reservedForOutput
  )

  let working = messages
  let estimate = estimateTokens(system, working)
  if (estimate <= budget) return { messages: working, notice: null, estimatedTokens: estimate }

  let compacted = 0
  const cutoff = Math.max(0, working.length - RECENT_WINDOW)
  working = working.map((message, index) => {
    if (index >= cutoff) return message
    let touched = false

    const content = message.content.map((block) => {
      if (block.type !== 'tool_result' || block.content.length <= COMPACTED_TOOL_RESULT_CHARS) {
        return block
      }
      touched = true
      compacted++
      return {
        ...block,
        content:
          `${block.content.slice(0, COMPACTED_TOOL_RESULT_CHARS)}\n… ` +
          `[${block.content.length - COMPACTED_TOOL_RESULT_CHARS} characters trimmed to save context; ` +
          're-run the tool if you need the rest]'
      } satisfies ContentBlock
    })

    return touched ? { ...message, content } : message
  })

  estimate = estimateTokens(system, working)
  if (estimate <= budget) {
    return {
      messages: working,
      notice: `Trimmed ${compacted} older tool result${compacted === 1 ? '' : 's'} to stay within the context window.`,
      estimatedTokens: estimate
    }
  }

  let dropped = 0
  while (estimate > budget) {
    const cut = nextCleanBoundary(working, 1)
    // Nothing left to drop without breaking the last exchange.
    if (cut === -1 || cut >= working.length) break

    dropped += cut
    working = working.slice(cut)
    estimate = estimateTokens(system, working)
  }

  if (dropped > 0) {
    working = [prefixNotice(working[0], dropped), ...working.slice(1)]
    estimate = estimateTokens(system, working)
  }

  const parts: string[] = []
  if (dropped > 0) parts.push(`dropped ${dropped} earlier message${dropped === 1 ? '' : 's'}`)
  if (compacted > 0) parts.push(`trimmed ${compacted} tool result${compacted === 1 ? '' : 's'}`)

  return {
    messages: working,
    notice: parts.length > 0 ? `Context was getting full — ${parts.join(' and ')}.` : null,
    estimatedTokens: estimate
  }
}

/**
 * Index of the first user message at or after `from` that starts a fresh turn
 * (i.e. is a real user message, not a bag of tool results owed to an assistant
 * message we would be dropping).
 */
function nextCleanBoundary(messages: Message[], from: number): number {
  for (let i = from; i < messages.length; i++) {
    const message = messages[i]
    if (message.role !== 'user') continue
    if (message.content.some((block) => block.type === 'tool_result')) continue
    return i
  }
  return -1
}

function prefixNotice(message: Message, dropped: number): Message {
  const note =
    `[${dropped} earlier message${dropped === 1 ? '' : 's'} were dropped to fit the context ` +
    'window. Ask the user if you need details from earlier in the conversation.]\n\n'

  const first = message.content.find((block) => block.type === 'text')
  if (first) {
    return {
      ...message,
      content: message.content.map((block) =>
        block === first ? { type: 'text', text: note + (block as { text: string }).text } : block
      )
    }
  }

  return { ...message, content: [{ type: 'text', text: note }, ...message.content] }
}

function blockSize(block: ContentBlock): number {
  switch (block.type) {
    case 'text':
    case 'thinking':
      return block.text.length
    case 'tool_use':
      return JSON.stringify(block.input ?? {}).length + block.name.length + 16
    case 'tool_result':
      return block.content.length + 16
    case 'image':
      // Rough: a typical screenshot lands around 1.5k tokens.
      return 5_000
  }
}
