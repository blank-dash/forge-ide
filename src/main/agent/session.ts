import { randomUUID } from 'node:crypto'
import { effortToBudget } from '@shared/types'
import type {
  AgentEvent,
  ContentBlock,
  Message,
  PermissionDecision,
  PermissionRequest,
  SessionRecord,
  Settings,
  TokenUsage,
  ToolResultBlock,
  ToolUseBlock
} from '@shared/types'
import { computeCost, resolveModel, type ResolvedModel } from '../providers'
import { ChangeTracker } from './changes'
import { trimForContext } from './context'
import { findMentionedPaths } from './paths'
import { evaluatePermission, ruleTarget } from './permissions'
import { buildSystemPrompt } from './prompt'
import {
  activeTools,
  findTool,
  toolSchemas,
  ToolError,
  type ToolContext,
  type ToolDef
} from './tools'

const MAX_AGENT_TURNS = 80
const MAX_ATTEMPTS = 3
const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504, 529])

export interface SessionDeps {
  cwd(): string
  settings(): Settings
  saveSettings(next: Settings): void
  emit(event: AgentEvent): void
  /**
   * Shows the permission dialog and resolves with the user's choice, or with a
   * denial if the turn is interrupted while the dialog is still open.
   */
  askUser(request: PermissionRequest, signal: AbortSignal): Promise<PermissionDecision>
  mcpTools(): ToolDef<Record<string, never>>[]
  gitContext(): Promise<string>
  persist(record: SessionRecord): void
}

export class AgentSession {
  id: string = randomUUID()
  title = 'New session'
  messages: Message[] = []
  totals: TokenUsage = emptyUsage()
  readonly changes = new ChangeTracker()

  private controller: AbortController | null = null
  private running = false
  /** Paths the user named in this conversation; see findMentionedPaths. */
  private grants = new Set<string>()

  constructor(private readonly deps: SessionDeps) {}

  get isRunning(): boolean {
    return this.running
  }

  abort(): void {
    this.controller?.abort()
  }

  reset(): void {
    this.abort()
    this.id = randomUUID()
    this.messages = []
    this.title = 'New session'
    this.totals = emptyUsage()
    this.grants.clear()
    this.changes.clear()
  }

  restore(record: SessionRecord): void {
    this.abort()
    this.id = record.id
    this.title = record.title
    this.messages = record.messages ?? []
    this.totals = record.totals ?? emptyUsage()
    this.grants.clear()
    this.changes.clear()
  }

  snapshot(): SessionRecord {
    return {
      id: this.id,
      title: this.title,
      updatedAt: Date.now(),
      messageCount: this.messages.length,
      messages: this.messages,
      totals: this.totals
    }
  }

  async send(text: string, images: Array<{ mediaType: string; data: string }> = []): Promise<void> {
    if (this.running) throw new Error('A turn is already running. Stop it first.')

    const content: ContentBlock[] = []
    for (const image of images) {
      content.push({ type: 'image', mediaType: image.mediaType, data: image.data })
    }
    content.push({ type: 'text', text })

    this.messages.push({ id: randomUUID(), role: 'user', content, createdAt: Date.now() })
    if (this.title === 'New session') this.title = deriveTitle(text)

    // A path the user typed themselves needs no approval dialog.
    for (const granted of await findMentionedPaths(text)) this.grants.add(granted)

    await this.runLoop()
  }

  /* ---------------------------------------------------------------- */

  private async runLoop(): Promise<void> {
    this.running = true
    this.controller = new AbortController()
    const signal = this.controller.signal

    try {
      for (let turn = 0; turn < MAX_AGENT_TURNS; turn++) {
        if (signal.aborted) break

        const settings = this.deps.settings()
        const resolved = resolveModel(settings, settings.activeModel)
        const tools = activeTools(this.deps.mcpTools(), settings.readOnly)

        const system = await buildSystemPrompt({
          cwd: this.deps.cwd(),
          settings,
          gitContext: await this.deps.gitContext(),
          mcpTools: tools.filter((tool) => tool.name.startsWith('mcp__')).map((tool) => tool.name)
        })

        const trimmed = trimForContext(
          system,
          this.messages,
          resolved.model,
          Math.min(settings.maxOutputTokens, resolved.model.maxOutputTokens)
        )
        if (trimmed.notice) {
          this.messages = trimmed.messages
          this.deps.emit({ type: 'notice', message: trimmed.notice })
        }

        this.deps.emit({
          type: 'context',
          used: trimmed.estimatedTokens,
          window: resolved.model.contextWindow,
          estimated: true
        })

        const outcome = await this.runOneTurn(resolved, system, trimmed.messages, tools, signal)
        if (!outcome) break

        if (outcome.toolUses.length === 0) break

        const results = await this.runTools(outcome.toolUses, outcome.messageId, tools, signal)
        this.messages.push({
          id: randomUUID(),
          role: 'user',
          content: results,
          createdAt: Date.now()
        })

        if (signal.aborted) break
        if (turn === MAX_AGENT_TURNS - 1) {
          this.deps.emit({
            type: 'notice',
            message: `Stopped after ${MAX_AGENT_TURNS} tool rounds. Send another message to continue.`
          })
        }
      }
    } catch (error) {
      this.emitError(error)
    } finally {
      this.running = false
      this.controller = null
      this.persist()
      this.deps.emit({ type: 'idle' })
    }
  }

  /**
   * One request/response exchange with the model, with bounded retries for
   * transient failures. Retrying is only safe before anything has been streamed
   * to the UI, otherwise the user would see the text twice.
   */
  private async runOneTurn(
    resolved: ResolvedModel,
    system: string,
    messages: Message[],
    tools: ToolDef<Record<string, never>>[],
    signal: AbortSignal
  ): Promise<{ messageId: string; toolUses: ToolUseBlock[] } | null> {
    const settings = this.deps.settings()

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const messageId = randomUUID()
      const blocks: ContentBlock[] = []
      const toolUses: ToolUseBlock[] = []
      const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
      let stopReason = 'stop'
      let text = ''
      let thinking = ''
      let emitted = false

      this.deps.emit({ type: 'turn_start', messageId, model: resolved.ref })

      try {
        const stream = resolved.adapter.stream({
          provider: resolved.provider,
          model: resolved.model,
          system,
          messages,
          tools: resolved.model.supportsTools ? toolSchemas(tools) : [],
          maxOutputTokens: Math.min(settings.maxOutputTokens, resolved.model.maxOutputTokens),
          temperature: resolved.model.temperature ?? settings.temperature,
          effort: settings.effort,
          // "Off" means off, whatever the model override says; otherwise an
          // explicit per-model budget beats the effort preset.
          thinkingBudget:
            settings.effort === 'off'
              ? 0
              : (resolved.model.thinkingBudget ??
                effortToBudget(settings.effort, resolved.model.maxOutputTokens)),
          signal
        })

        for await (const event of stream) {
          switch (event.type) {
            case 'text':
              text += event.text
              emitted = true
              this.deps.emit({ type: 'text_delta', messageId, text: event.text })
              break
            case 'thinking':
              thinking += event.text
              emitted = true
              this.deps.emit({ type: 'thinking_delta', messageId, text: event.text })
              break
            case 'tool_use': {
              const block: ToolUseBlock = {
                type: 'tool_use',
                id: event.id,
                name: event.name,
                input: event.input
              }
              toolUses.push(block)
              emitted = true
              this.deps.emit({ type: 'tool_start', messageId, block })
              break
            }
            case 'usage':
              // Anthropic reports input once and output incrementally; OpenAI
              // sends a single final total. Max covers both without double
              // counting.
              usage.input = Math.max(usage.input, event.input)
              usage.output = Math.max(usage.output, event.output)
              usage.cacheRead = Math.max(usage.cacheRead, event.cacheRead ?? 0)
              usage.cacheWrite = Math.max(usage.cacheWrite, event.cacheWrite ?? 0)
              break
            case 'stop':
              stopReason = event.reason
              break
          }
        }
      } catch (error) {
        if (signal.aborted) {
          // Tool calls the model asked for never ran, and an assistant turn
          // carrying tool_use without a matching tool_result is rejected by
          // every provider on the next request — it would break the whole
          // conversation. Drop them and let the UI resolve their spinners.
          for (const use of toolUses) {
            const stopped = errorResult(use.id, 'Interrupted before this tool ran.')
            this.deps.emit({ type: 'tool_end', messageId, toolUseId: use.id, result: stopped })
          }
          this.finishTurn(messageId, resolved, blocks, thinking, text, [], usage, 'aborted')
          return null
        }

        const retryable = !emitted && attempt < MAX_ATTEMPTS && isRetryable(error)
        if (!retryable) throw error

        // Nothing was streamed, so the turn this attempt announced has no
        // content and must not be left behind as an empty bubble.
        this.deps.emit({ type: 'turn_abandoned', messageId })

        const delay = 800 * 2 ** (attempt - 1)
        this.deps.emit({
          type: 'notice',
          message: `${(error as Error).message} Retrying in ${Math.round(delay / 1000)}s (attempt ${attempt + 1}/${MAX_ATTEMPTS}).`
        })
        await sleep(delay, signal)
        continue
      }

      this.finishTurn(messageId, resolved, blocks, thinking, text, toolUses, usage, stopReason)
      return { messageId, toolUses }
    }

    return null
  }

  private finishTurn(
    messageId: string,
    resolved: ResolvedModel,
    blocks: ContentBlock[],
    thinking: string,
    text: string,
    toolUses: ToolUseBlock[],
    usage: Omit<TokenUsage, 'costUsd'>,
    stopReason: string
  ): void {
    if (thinking) blocks.push({ type: 'thinking', text: thinking })
    if (text) blocks.push({ type: 'text', text })
    blocks.push(...toolUses)

    const turnUsage: TokenUsage = { ...usage, costUsd: computeCost(resolved.model, usage) }
    this.totals = addUsage(this.totals, turnUsage)

    // An assistant turn with no content at all would be rejected on the next
    // request by every provider, so keep it out of the history.
    if (blocks.length > 0) {
      this.messages.push({
        id: messageId,
        role: 'assistant',
        content: blocks,
        createdAt: Date.now(),
        model: resolved.ref,
        usage: turnUsage
      })
    }

    this.deps.emit({ type: 'turn_end', messageId, usage: turnUsage, stopReason })

    // The provider's own input count is the real context size, so it replaces
    // the estimate as soon as one request has completed.
    const consumed = usage.input + usage.cacheRead + usage.cacheWrite
    if (consumed > 0) {
      this.deps.emit({
        type: 'context',
        used: consumed + usage.output,
        window: resolved.model.contextWindow,
        estimated: false
      })
    }
  }

  private async runTools(
    toolUses: ToolUseBlock[],
    messageId: string,
    tools: ToolDef<Record<string, never>>[],
    signal: AbortSignal
  ): Promise<ToolResultBlock[]> {
    const results: ToolResultBlock[] = []

    for (const use of toolUses) {
      if (signal.aborted) {
        const stopped = errorResult(use.id, 'Interrupted by the user before this tool ran.')
        results.push(stopped)
        this.deps.emit({ type: 'tool_end', messageId, toolUseId: use.id, result: stopped })
        continue
      }

      const result = await this.runOneTool(use, tools, signal)
      results.push(result)
      this.deps.emit({ type: 'tool_end', messageId, toolUseId: use.id, result })
    }

    return results
  }

  private async runOneTool(
    use: ToolUseBlock,
    tools: ToolDef<Record<string, never>>[],
    signal: AbortSignal
  ): Promise<ToolResultBlock> {
    const tool = findTool(tools, use.name)
    if (!tool) {
      const available = tools.map((entry) => entry.name).join(', ')
      return errorResult(
        use.id,
        `Unknown tool "${use.name}". Available tools: ${available || 'none'}.`
      )
    }

    const settings = this.deps.settings()

    const ctx: ToolContext = {
      cwd: this.deps.cwd(),
      readOnly: settings.readOnly,
      editApproval: settings.editApproval,
      externalRoots: settings.externalRoots,
      sessionGrants: [...this.grants],
      signal,
      changes: this.changes,
      notifyFileChanged: (absolutePath) =>
        this.deps.emit({ type: 'file_changed', path: absolutePath }),
      requestPermission: (request) => this.requestPermission(request, signal)
    }

    try {
      const outcome = await tool.run(use.input as never, ctx)
      return {
        type: 'tool_result',
        toolUseId: use.id,
        content: outcome.content,
        isError: false,
        display: outcome.display
      }
    } catch (error) {
      if (signal.aborted) return errorResult(use.id, 'Interrupted by the user.')
      return errorResult(use.id, error instanceof Error ? error.message : String(error))
    }
  }

  private async requestPermission(
    request: Omit<PermissionRequest, 'id'>,
    signal: AbortSignal
  ): Promise<boolean> {
    const settings = this.deps.settings()
    const verdict = evaluatePermission({
      readOnly: settings.readOnly,
      editApproval: settings.editApproval,
      commandApproval: settings.commandApproval,
      allowRules: settings.allowRules,
      denyRules: settings.denyRules,
      request,
      target: ruleTarget(request)
    })

    if (verdict === 'allow') return true
    if (verdict === 'deny') {
      throw new ToolError(
        settings.readOnly
          ? 'Read-only is on — you cannot change files or run commands. Describe what you would do instead.'
          : 'This action is blocked by a deny rule.'
      )
    }

    if (signal.aborted) throw new ToolError('Interrupted by the user.')

    const decision = await this.deps.askUser({ ...request, id: randomUUID() }, signal)

    if (decision.action === 'allow_always') {
      this.remember(request)
      return true
    }

    if (decision.action === 'deny') {
      throw new ToolError(
        decision.reason?.trim()
          ? `User rejected this action: ${decision.reason.trim()}`
          : 'User rejected this action.'
      )
    }

    return true
  }

  /** Persists an "always allow" answer as a rule, or an approved external root. */
  private remember(request: Omit<PermissionRequest, 'id'>): void {
    const settings = this.deps.settings()

    if (request.kind === 'external') {
      const root = request.suggestedRule
      if (!root || settings.externalRoots.includes(root)) return
      this.deps.saveSettings({ ...settings, externalRoots: [...settings.externalRoots, root] })
      return
    }

    if (!request.suggestedRule || settings.allowRules.includes(request.suggestedRule)) return
    this.deps.saveSettings({
      ...settings,
      allowRules: [...settings.allowRules, request.suggestedRule]
    })
  }

  private persist(): void {
    if (!this.deps.settings().autoSaveSessions) return
    if (this.messages.length === 0) return
    this.deps.persist(this.snapshot())
  }

  private emitError(error: unknown): void {
    const err = error as Error & { detail?: string; name?: string }

    if (err?.name === 'AbortError' || this.controller?.signal.aborted) {
      this.deps.emit({ type: 'notice', message: 'Interrupted.' })
      return
    }

    this.deps.emit({ type: 'error', message: err?.message ?? String(error), detail: err?.detail })
  }
}

function isRetryable(error: unknown): boolean {
  const err = error as { status?: number; message?: string; name?: string }
  if (err?.status && RETRYABLE_STATUS.has(err.status)) return true
  // Socket resets and DNS blips surface as plain Error with these codes.
  return /ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|fetch failed/i.test(
    err?.message ?? ''
  )
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms)
    function done(): void {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
    signal.addEventListener('abort', done, { once: true })
  })
}

function errorResult(toolUseId: string, message: string): ToolResultBlock {
  return {
    type: 'tool_result',
    toolUseId,
    content: `Error: ${message}`,
    isError: true,
    display: { kind: 'text', summary: message.slice(0, 120), body: message }
  }
}

function emptyUsage(): TokenUsage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0 }
}

function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    costUsd: a.costUsd + b.costUsd
  }
}

function deriveTitle(text: string): string {
  const clean = text.replace(/\s+/g, ' ').trim()
  if (!clean) return 'New session'
  const words = clean.split(' ').slice(0, 7).join(' ')
  return words.length > 60 ? `${words.slice(0, 57)}…` : words
}
