import type { AgentEvent } from '@shared/types'
import type { ChatEntry, SessionView } from './store'

export function reduceSession(view: SessionView, event: AgentEvent): SessionView {
  switch (event.type) {
    case 'turn_start':
      return {
        ...view,
        running: true,
        entries: [
          ...view.entries,
          {
            id: event.messageId,
            role: 'assistant',
            blocks: [],
            streaming: true,
            model: event.model
          }
        ]
      }
    case 'text_delta':
      return {
        ...view,
        entries: mapEntry(view.entries, event.messageId, (entry) => ({
          ...entry,
          blocks: appendText(entry.blocks, 'text', event.text)
        }))
      }
    case 'thinking_delta':
      return {
        ...view,
        entries: mapEntry(view.entries, event.messageId, (entry) => ({
          ...entry,
          blocks: appendText(entry.blocks, 'thinking', event.text)
        }))
      }
    case 'tool_start':
      return {
        ...view,
        entries: mapEntry(view.entries, event.messageId, (entry) => ({
          ...entry,
          blocks: [...entry.blocks, { kind: 'tool', use: event.block }]
        }))
      }
    case 'tool_end':
      return {
        ...view,
        entries: mapEntry(view.entries, event.messageId, (entry) => ({
          ...entry,
          blocks: entry.blocks.map((block) =>
            block.kind === 'tool' && block.use.id === event.toolUseId
              ? { ...block, result: event.result }
              : block
          )
        }))
      }
    case 'turn_end':
      return {
        ...view,
        totals: addUsage(view.totals, event.usage),
        entries: mapEntry(view.entries, event.messageId, (entry) => ({
          ...entry,
          streaming: false,
          usage: event.usage,
          durationMs: event.durationMs
        }))
      }
    case 'turn_abandoned':
      return { ...view, entries: view.entries.filter((entry) => entry.id !== event.messageId) }
    case 'idle':
      return {
        ...view,
        running: false,
        queuedCount: 0,
        entries: view.entries
          .filter((entry) => entry.role === 'user' || entry.blocks.length > 0)
          .map((entry) => ({ ...entry, streaming: false }))
      }
    case 'error':
      return {
        ...view,
        errors: [
          ...view.errors,
          { id: `err-${view.errors.length}`, message: event.message, detail: event.detail }
        ]
      }
    case 'notice':
      return {
        ...view,
        notices: [
          ...view.notices.slice(-3),
          { id: `notice-${view.notices.length}`, message: event.message }
        ]
      }
    case 'changes':
      return { ...view, changes: event.changes }
    case 'queued':
      return { ...view, queuedCount: event.pending }
    case 'context':
      return {
        ...view,
        context: { used: event.used, window: event.window, estimated: event.estimated }
      }
    default:
      return view
  }
}

function mapEntry(
  entries: ChatEntry[],
  id: string,
  update: (entry: ChatEntry) => ChatEntry
): ChatEntry[] {
  return entries.map((entry) => (entry.id === id ? update(entry) : entry))
}

function appendText(
  blocks: ChatEntry['blocks'],
  kind: 'text' | 'thinking',
  text: string
): ChatEntry['blocks'] {
  const last = blocks.at(-1)
  if (last?.kind === kind) return [...blocks.slice(0, -1), { kind, text: last.text + text }]
  return [...blocks, { kind, text }]
}

function addUsage(a: SessionView['totals'], b: SessionView['totals']): SessionView['totals'] {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    reasoning: a.reasoning + b.reasoning,
    costUsd: a.costUsd + b.costUsd
  }
}
