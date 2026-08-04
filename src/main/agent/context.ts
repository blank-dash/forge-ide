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
  let summary = ''
  while (estimate > budget) {
    const cut = nextCleanBoundary(working, 1)
    // Nothing left to drop without breaking the last exchange.
    if (cut === -1 || cut >= working.length) break

    // Keep what those turns were about before letting go of them. Losing the
    // detail is unavoidable; losing the thread is not, and an agent that
    // forgets what it was asked halfway through a long task is useless.
    summary += summarise(working.slice(0, cut))
    dropped += cut
    working = working.slice(cut)
    estimate = estimateTokens(system, working)
  }

  if (dropped > 0) {
    working = [prefixSummary(working[0], dropped, summary), ...working.slice(1)]
    estimate = estimateTokens(system, working)
  }

  const parts: string[] = []
  if (dropped > 0) parts.push(`summarised ${dropped} earlier message${dropped === 1 ? '' : 's'}`)
  if (compacted > 0) parts.push(`trimmed ${compacted} tool result${compacted === 1 ? '' : 's'}`)

  return {
    messages: working,
    notice: parts.length > 0 ? `Context was getting full — ${parts.join(' and ')}.` : null,
    estimatedTokens: estimate
  }
}

/**
 * A cheap, deterministic digest of turns about to be dropped: what the user
 * asked, what the assistant said it did, and which files it touched. No model
 * call — this runs on every request and has to be free.
 */
function summarise(messages: Message[]): string {
  const lines: string[] = []

  for (const message of messages) {
    for (const block of message.content) {
      if (block.type === 'text' && block.text.trim()) {
        const text = block.text.replace(/\s+/g, ' ').trim()
        lines.push(`${message.role === 'user' ? 'You asked' : 'I said'}: ${clip(text, 220)}`)
      } else if (block.type === 'tool_use') {
        const target = describeTarget(block.input)
        lines.push(`I ran ${block.name}${target ? `(${target})` : ''}`)
      }
    }
  }

  // Collapse runs of identical tool lines — a loop of twenty reads is one fact.
  const collapsed: string[] = []
  for (const line of lines) {
    const last = collapsed[collapsed.length - 1]
    if (last && last.startsWith(line.split('(')[0]) && line.startsWith('I ran')) continue
    collapsed.push(line)
  }

  return `${collapsed.join('\n')}\n`
}

function describeTarget(input: Record<string, unknown>): string {
  for (const key of ['path', 'pattern', 'command', 'name']) {
    const value = input?.[key]
    if (typeof value === 'string' && value) return clip(value.split('\n')[0], 60)
  }
  return ''
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
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

function prefixSummary(message: Message, dropped: number, summary: string): Message {
  const note =
    `[Earlier in this conversation — ${dropped} message${dropped === 1 ? '' : 's'} condensed to ` +
    `fit the context window. The detail is gone; this is what happened:\n` +
    `${clip(summary.trim(), 4_000)}\n` +
    'Re-read any file you need to be certain about rather than trusting this summary.]\n\n'

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
