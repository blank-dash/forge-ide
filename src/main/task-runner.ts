import { decideForTask, settingsForTask } from '@shared/tasks'
import type { AgentEvent, ScheduledTask, Settings, TaskRunResult, TokenUsage } from '@shared/types'
import type { SessionManager } from './agent/manager'

/**
 * Runs a scheduled task in a real conversation, with nobody watching.
 *
 * The conversation is a normal one: it appears in history, you can open it and
 * read exactly what the agent did. What differs is that it never asks — every
 * permission is answered from the level chosen when the task was written — and
 * that it opens in the background rather than stealing the view you are on.
 */
export interface TaskRunnerDeps {
  manager: SessionManager
  settings(): Settings
  /** Streams progress out, e.g. to a toast. */
  emit?(event: { taskId: string; event: AgentEvent }): void
  /**
   * Marks a conversation as belonging to a task, for as long as it exists.
   *
   * Its deps are permanently overridden with the task's permission level — for
   * a "full" task that means every command auto-approved with no prompt. If the
   * user could open it and keep typing, their own messages would inherit that,
   * while the settings UI went on displaying the safe global state.
   */
  claim?(sessionId: string): void
  release?(sessionId: string): void
}

const MAX_SUMMARY_CHARS = 400

export class TaskRunner {
  constructor(private readonly deps: TaskRunnerDeps) {}

  async run(task: ScheduledTask): Promise<TaskRunResult> {
    const startedAt = Date.now()
    const collected = new Collector()

    // `activate: false` so a task firing while you read something else does not
    // yank the view across; the decorated deps replace the parts of a normal
    // conversation that assume somebody is sitting in front of it.
    const session = this.deps.manager.create({
      activate: false,
      decorate: (base) => ({
        ...base,
        settings: () => settingsForTask(this.deps.settings(), task.permission, task.model),
        // The one unbounded wait in the agent loop. Answering synchronously
        // here is what keeps an unattended run from hanging until restart.
        askUser: async (request) =>
          decideForTask(task.permission, request.kind, request.destructive),
        emit: (event) => {
          collected.take(event)
          base.emit(event)
          this.deps.emit?.({ taskId: task.id, event })
        }
      })
    })

    session.title = task.name
    this.deps.claim?.(session.id)

    try {
      // send() resolves after the whole loop, and never rejects: a provider
      // failure arrives as an event, which is why the collector exists.
      await session.send(task.prompt)
    } catch (error) {
      // Only reachable if a dependency itself throws, but a scheduler that
      // loses a task to an unhandled rejection is worse than one that logs it.
      return {
        startedAt,
        durationMs: Date.now() - startedAt,
        status: 'error',
        summary: '',
        error: (error as Error).message,
        usage: collected.usage,
        sessionId: session.id
      }
    }

    return {
      startedAt,
      durationMs: Date.now() - startedAt,
      status: collected.status,
      summary: collected.summary(),
      error: collected.error,
      usage: collected.usage,
      sessionId: session.id
    }
  }
}

/**
 * Reads the outcome of a turn out of its event stream.
 *
 * The session object cannot answer these questions directly: `totals` is
 * cumulative across every turn including retries, the last message is not
 * always the assistant's, and a failed turn still resolves normally. The events
 * are the only place where what actually happened is unambiguous.
 */
class Collector {
  usage: TokenUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, costUsd: 0 }
  error?: string
  private aborted = false
  /** Assistant text keyed by message, so an abandoned retry can be dropped. */
  private texts = new Map<string, string>()
  private order: string[] = []

  private truncated = false

  get status(): TaskRunResult['status'] {
    // Ordered by what the reader most needs to know. An interrupted run and a
    // failed one are both "it did not finish", but only one is worth a retry.
    if (this.aborted) return 'cancelled'
    if (this.error) return 'error'
    return this.truncated ? 'truncated' : 'ok'
  }

  take(event: AgentEvent): void {
    switch (event.type) {
      case 'turn_start':
        if (!this.texts.has(event.messageId)) {
          this.texts.set(event.messageId, '')
          this.order.push(event.messageId)
        }
        break

      case 'text_delta':
        this.texts.set(event.messageId, (this.texts.get(event.messageId) ?? '') + event.text)
        break

      case 'turn_abandoned':
        // A retried turn announced itself and then withdrew. Keeping its text
        // would attribute a half-sentence to the result.
        this.texts.delete(event.messageId)
        this.order = this.order.filter((id) => id !== event.messageId)
        break

      case 'turn_end':
        this.usage = addUsage(this.usage, event.usage)
        if (event.stopReason === 'aborted') this.aborted = true
        break

      case 'error':
        // First error wins: later ones are usually consequences of it.
        this.error ??= event.detail ? `${event.message} — ${event.detail}` : event.message
        break

      case 'idle':
        // The only signal that distinguishes a finished run from one that was
        // stopped between turns or cut off at the tool-round cap. Matching on
        // notice text used to be the alternative, and it missed both.
        if (event.aborted) this.aborted = true
        if (event.truncated) this.truncated = true
        break

      default:
        break
    }
  }

  /** The agent's closing message, trimmed to something a list can show. */
  summary(): string {
    for (let index = this.order.length - 1; index >= 0; index--) {
      const text = (this.texts.get(this.order[index]) ?? '').trim()
      if (text) return text.length > MAX_SUMMARY_CHARS
        ? `${text.slice(0, MAX_SUMMARY_CHARS).trimEnd()}…`
        : text
    }
    return ''
  }
}

function addUsage(total: TokenUsage, next: TokenUsage): TokenUsage {
  return {
    input: total.input + next.input,
    output: total.output + next.output,
    cacheRead: total.cacheRead + next.cacheRead,
    cacheWrite: total.cacheWrite + next.cacheWrite,
    reasoning: total.reasoning + next.reasoning,
    costUsd: total.costUsd + next.costUsd
  }
}
