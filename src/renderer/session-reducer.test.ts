import { describe, expect, it } from 'vitest'
import type { AgentEvent, TokenUsage, ToolResultBlock, ToolUseBlock } from '@shared/types'
import { reduceSession } from './session-reducer'
import type { SessionView } from './store'

const usage: TokenUsage = {
  input: 1,
  output: 2,
  cacheRead: 3,
  cacheWrite: 4,
  reasoning: 5,
  costUsd: 0.01
}
const tool: ToolUseBlock = {
  type: 'tool_use',
  id: 'tool-1',
  name: 'read_file',
  input: { path: 'a.ts' }
}
const result: ToolResultBlock = {
  type: 'tool_result',
  toolUseId: tool.id,
  content: 'ok',
  isError: false
}
const empty = (): SessionView => ({
  entries: [],
  errors: [],
  notices: [],
  running: false,
  totals: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, costUsd: 0 },
  changes: [],
  queuedCount: 0,
  context: null
})

const events: AgentEvent[] = [
  { type: 'turn_start', messageId: 'turn-1', model: 'provider:model' },
  { type: 'text_delta', messageId: 'turn-1', text: 'hello' },
  { type: 'thinking_delta', messageId: 'turn-1', text: 'reason' },
  { type: 'tool_start', messageId: 'turn-1', block: tool },
  { type: 'tool_end', messageId: 'turn-1', toolUseId: tool.id, result },
  { type: 'turn_end', messageId: 'turn-1', usage, stopReason: 'stop', durationMs: 12 },
  { type: 'queued', text: 'later', pending: 1 },
  { type: 'context', used: 10, window: 100, estimated: true },
  { type: 'changes', changes: [] },
  { type: 'notice', message: 'notice' },
  { type: 'error', message: 'error' },
  { type: 'limits', limit: { providerId: 'p', updatedAt: 1 } },
  { type: 'file_changed', path: 'a.ts' },
  { type: 'git_dirty' },
  { type: 'idle' }
]

describe('reduceSession', () => {
  it('handles every agent event without mutating the previous view', () => {
    let view = empty()
    for (const event of events) {
      const before = structuredClone(view)
      const next = reduceSession(view, event)
      expect(view).toEqual(before)
      view = next
    }
    expect(view.entries[0]?.blocks).toHaveLength(3)
    expect(view.totals).toEqual(usage)
    expect(view.running).toBe(false)
    expect(view.queuedCount).toBe(0)
  })

  it('removes an abandoned turn', () => {
    const started = reduceSession(empty(), events[0])
    expect(reduceSession(started, { type: 'turn_abandoned', messageId: 'turn-1' }).entries).toEqual(
      []
    )
  })
})
