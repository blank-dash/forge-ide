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
import { retryDelay } from '../providers/types'
import { mapLimit } from '../util/pool'
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

/**
 * How long a tool gets to notice it was stopped before the turn moves on
 * without it. Long enough for a well-behaved tool to tidy up, short enough that
 * pressing stop feels like it did something.
 */
const TOOL_ABANDON_MS = 2500
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
  /** The `use_skill` tool, or null when the library is empty. */
  skillTool(): ToolDef<Record<string, never>> | null
  /** Tools backed by main-process objects, e.g. the built-in browser. */
  hostTools(): ToolDef<Record<string, never>>[]
  /** Called with each turn's usage, for the spending history. */
  recordUsage(usage: TokenUsage): void
  /** Called before any file is written, so the turn can be undone. */
  beforeWrite(absolutePath: string): Promise<void>
  /** Turn boundaries, for the same reason. */
  turnBegan(): void
  turnEnded(label: string): void
  /** Names and descriptions only — bodies load through the tool. */
  skillCatalogue(): string
  gitContext(): Promise<string>
  persist(record: SessionRecord): void
}

export class AgentSession {
  id: string = randomUUID()
  title = 'New session'
  model: string | undefined
  messages: Message[] = []
  totals: TokenUsage = emptyUsage()
  readonly changes = new ChangeTracker()

  private controller: AbortController | null = null
  private running = false
  /** Paths the user named in this conversation; see findMentionedPaths. */
  private grants = new Set<string>()
  /** Messages sent while a turn was running, delivered at the next boundary. */
  private repeatedTools = new Map<string, number>()
  private queued: Array<{ text: string; images: Array<{ mediaType: string; data: string }> }> = []

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
    this.model = undefined
    this.totals = emptyUsage()
    this.grants.clear()
    this.queued = []
    this.repeatedTools.clear()
    this.changes.clear()
  }

  restore(record: SessionRecord): void {
    this.abort()
    this.id = record.id
    this.title = record.title
    this.model = record.model
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
      model: this.model,
      messages: this.messages,
      totals: this.totals
    }
  }

  setModel(model: string): void {
    this.model = model
    this.persist()
  }

  /**
   * Sending while a turn is running queues the message instead of refusing it.
   * The agent picks it up at the next boundary — after the tools it is already
   * running finish — so you can correct or extend a request without stopping
   * the work and starting over.
   */
  async send(text: string, images: Array<{ mediaType: string; data: string }> = []): Promise<void> {
    if (this.running) {
      this.queued.push({ text, images })
      for (const granted of await findMentionedPaths(text)) this.grants.add(granted)
      this.deps.emit({ type: 'queued', text, pending: this.queued.length })
      return
    }

    // Claimed here rather than in runLoop, which is several awaits away: two
    // messages sent in the same tick would otherwise both clear the guard above
    // and start competing loops on one conversation. It also means the sidebar
    // marks the conversation as working the instant you leave it.
    this.running = true

    try {
      const content: ContentBlock[] = []
      for (const image of images) {
        content.push({ type: 'image', mediaType: image.mediaType, data: image.data })
      }
      content.push({ type: 'text', text })

      this.messages.push({ id: randomUUID(), role: 'user', content, createdAt: Date.now() })
      if (this.title === 'New session') this.title = deriveTitle(text)
      // Saved now rather than only when the reply lands: a conversation you
      // have already started should be in the history list while it is still
      // being answered, not appear minutes later.
      this.persist()

      // A path the user typed themselves needs no approval dialog.
      for (const granted of await findMentionedPaths(text)) this.grants.add(granted)
    } catch (error) {
      // Releasing the claim matters more than the failure itself: leaving it set
      // would make the conversation permanently refuse to send.
      this.running = false
      this.emitError(error)
      this.deps.emit({ type: 'idle' })
      return
    }

    await this.runLoop()
  }

  /* ---------------------------------------------------------------- */

  private async runLoop(): Promise<void> {
    this.deps.turnBegan()
    this.running = true
    this.controller = new AbortController()
    const signal = this.controller.signal
    const settings = this.deps.settings()
    const turnLimit = Math.max(20, Math.min(500, settings.maxAgentTurns))
    const timeout = setTimeout(() => this.controller?.abort(), settings.turnTimeoutMs)
    timeout.unref?.()
    let truncated = false

    try {
      for (let turn = 0; turn < turnLimit; turn++) {
        if (signal.aborted) break

        const settings = this.deps.settings()
        const resolved = resolveModel(settings, this.model ?? settings.activeModel)
        const tools = activeTools(
          this.deps.mcpTools(),
          this.deps.skillTool(),
          settings.readOnly,
          this.deps.hostTools()
        )

        const system = await buildSystemPrompt({
          cwd: this.deps.cwd(),
          settings,
          gitContext: await this.deps.gitContext(),
          mcpTools: tools.filter((tool) => tool.name.startsWith('mcp__')).map((tool) => tool.name),
          skillCatalogue: this.deps.skillCatalogue()
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

        const turnCostBefore = this.totals.costUsd
        const outcome = await this.runOneTurn(resolved, system, trimmed.messages, tools, signal)
        if (this.shouldPauseForBudget(turnCostBefore, settings)) {
          this.deps.emit({
            type: 'notice',
            message:
              'Cost budget reached. Send another message to continue, or raise the budget in Settings.'
          })
          truncated = true
          break
        }
        if (!outcome) break

        if (outcome.toolUses.length === 0) {
          // The agent is done, but the user typed something while it worked.
          if (this.queued.length === 0 || signal.aborted) break
          this.messages.push({
            id: randomUUID(),
            role: 'user',
            content: this.drainQueue(),
            createdAt: Date.now()
          })
          continue
        }

        const results = await this.runTools(outcome.toolUses, outcome.messageId, tools, signal)
        this.messages.push({
          id: randomUUID(),
          role: 'user',
          // Anything typed mid-turn rides along with the tool results rather
          // than becoming a second consecutive user message, which providers
          // that require strict alternation reject.
          // Images ride as ordinary blocks in the same turn: only Anthropic
          // accepts one inside a tool result, and this shape works everywhere.
          content: [
            ...results,
            ...results.flatMap((entry) => entry.images ?? []),
            ...this.drainQueue()
          ],
          createdAt: Date.now()
        })

        if (signal.aborted) break
        if (turn === turnLimit - 1) {
          this.deps.emit({
            type: 'notice',
            message: `Agent turn limit reached (${turnLimit}). Send another message to continue.`
          })
          truncated = true
          this.deps.emit({
            type: 'notice',
            message: `Stopped after ${turnLimit} tool rounds. Send another message to continue.`
          })
        }
      }
    } catch (error) {
      this.emitError(error)
    } finally {
      clearTimeout(timeout)
      this.running = false
      this.controller = null
      this.persist()
      // Carried on the event rather than left to be inferred from prose: an
      // unattended caller has no other way to tell a finished run from one that
      // was cut short.
      this.deps.emit({ type: 'idle', aborted: signal.aborted, truncated })
      // After `idle`, so a listener that reacts to the turn ending sees the
      // checkpoint already recorded rather than racing it.
      this.deps.turnEnded(lastUserText(this.messages))
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

    for (let attempt = 1; attempt <= Math.max(1, Math.min(10, settings.maxAttempts)); attempt++) {
      const messageId = randomUUID()
      const blocks: ContentBlock[] = []
      const toolUses: ToolUseBlock[] = []
      let thinkingSignature: string | undefined
      const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 }
      let stopReason = 'stop'
      let text = ''
      let thinking = ''
      let emitted = false
      const startedAt = Date.now()

      this.deps.emit({ type: 'turn_start', messageId, model: resolved.ref })

      try {
        const stream = resolved.adapter.stream({
          provider: resolved.provider,
          model: resolved.model,
          sessionId: this.id,
          system,
          messages,
          tools: resolved.model.supportsTools ? toolSchemas(tools) : [],
          maxOutputTokens: Math.min(settings.maxOutputTokens, resolved.model.maxOutputTokens),
          temperature: resolved.model.temperature ?? settings.temperature,
          continuation: undefined,
          firstByteTimeoutMs: settings.providerFirstByteTimeoutMs,
          chunkTimeoutMs: settings.providerChunkTimeoutMs,
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
            case 'thinking_signature':
              thinkingSignature = event.signature
              break
            case 'redacted_thinking':
              blocks.push({ type: 'redacted_thinking', data: event.data })
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
              usage.reasoning = Math.max(usage.reasoning, event.reasoning ?? 0)
              break
            case 'limits':
              this.deps.emit({
                type: 'limits',
                limit: {
                  ...event.limit,
                  providerId: resolved.provider.id,
                  updatedAt: Date.now()
                }
              })
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
          this.finishTurn(
            messageId,
            resolved,
            blocks,
            thinking,
            thinkingSignature,
            text,
            [],
            usage,
            'aborted',
            startedAt
          )
          return null
        }

        if (signal.aborted) {
          this.deps.emit({ type: 'turn_abandoned', messageId })
          return null
        }

        const maxAttempts = Math.max(1, Math.min(10, settings.maxAttempts))
        const retryable =
          !emitted &&
          attempt < maxAttempts &&
          isRetryable(error)
        if (!retryable) {
          // Withdraw the turn before giving up. Without this its half-streamed
          // text stays in any listener's buffer and can be reported as the
          // answer — text that is not in the saved transcript, because
          // finishTurn never ran — and the tokens it already burned are lost
          // from the running total.
          this.deps.emit({ type: 'turn_abandoned', messageId })
          if (usage.input > 0 || usage.output > 0) {
            const spent: TokenUsage = { ...usage, costUsd: computeCost(resolved.model, usage) }
            this.totals = addUsage(this.totals, spent)
            this.deps.emit({
              type: 'turn_end',
              messageId,
              usage: spent,
              stopReason: 'failed',
              durationMs: Date.now() - startedAt
            })
          }
          throw error
        }

        // Proxy/network errors get infinite retry with 10s cooldown
        const isProxyError = error instanceof Error && /proxy|gateway|502/i.test(error.message)
        const delay = isProxyError ? 10_000 : retryDelay(error, attempt)
        this.deps.emit({
          type: 'notice',
          message: isProxyError
            ? `${(error as Error).message}. Reconnecting in 10s...`
            : `${(error as Error).message} Retrying in ${Math.round(delay / 1000)}s (attempt ${attempt + 1}/${maxAttempts}).`
        })
        await sleep(delay, signal)
        continue
      }

      this.finishTurn(
        messageId,
        resolved,
        blocks,
        thinking,
        thinkingSignature,
        text,
        toolUses,
        usage,
        stopReason,
        startedAt
      )
      return { messageId, toolUses }
    }

    return null
  }

  private finishTurn(
    messageId: string,
    resolved: ResolvedModel,
    blocks: ContentBlock[],
    thinking: string,
    thinkingSignature: string | undefined,
    text: string,
    toolUses: ToolUseBlock[],
    usage: Omit<TokenUsage, 'costUsd'>,
    stopReason: string,
    startedAt: number
  ): void {
    if (thinking) blocks.push({ type: 'thinking', text: thinking, signature: thinkingSignature })
    if (text) blocks.push({ type: 'text', text })
    blocks.push(...toolUses)

    const turnUsage: TokenUsage = { ...usage, costUsd: computeCost(resolved.model, usage) }
    this.totals = addUsage(this.totals, turnUsage)
    this.deps.recordUsage(turnUsage)

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

    this.deps.emit({
      type: 'turn_end',
      messageId,
      usage: turnUsage,
      stopReason,
      durationMs: Date.now() - startedAt
    })

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

  /** Empties the mid-turn queue into content blocks for the next request. */
  private drainQueue(): ContentBlock[] {
    if (this.queued.length === 0) return []

    const pending = this.queued
    this.queued = []
    const blocks: ContentBlock[] = []

    for (const entry of pending) {
      for (const image of entry.images) {
        blocks.push({ type: 'image', mediaType: image.mediaType, data: image.data })
      }
      // Labelled so the model reads it as a new instruction from the user
      // rather than as part of whatever tool output precedes it.
      blocks.push({ type: 'text', text: `[The user added while you were working]\n${entry.text}` })
    }

    this.deps.emit({ type: 'queued', text: '', pending: 0 })
    return blocks
  }

  private async runTools(
    toolUses: ToolUseBlock[],
    messageId: string,
    tools: ToolDef<Record<string, never>>[],
    signal: AbortSignal
  ): Promise<ToolResultBlock[]> {
    const results: ToolResultBlock[] = []
    let cursor = 0

    while (cursor < toolUses.length) {
      const use = toolUses[cursor]
      const tool = findTool(tools, use.name)
      if (!tool?.readOnly) {
        results.push(await this.runAndEmitTool(use, messageId, tools, signal))
        cursor++
        continue
      }

      const batch: ToolUseBlock[] = []
      while (cursor < toolUses.length && findTool(tools, toolUses[cursor].name)?.readOnly) {
        batch.push(toolUses[cursor++])
      }
      results.push(
        ...(await mapLimit(batch, 6, (entry) =>
          this.runAndEmitTool(entry, messageId, tools, signal)
        ))
      )
    }

    return results
  }

  private async runAndEmitTool(
    use: ToolUseBlock,
    messageId: string,
    tools: ToolDef<Record<string, never>>[],
    signal: AbortSignal
  ): Promise<ToolResultBlock> {
    const fingerprint = `${use.name}:${stableStringify(use.input)}`
    const repetitions = (this.repeatedTools.get(fingerprint) ?? 0) + 1
    this.repeatedTools.clear()
    this.repeatedTools.set(fingerprint, repetitions)
    if (repetitions >= 6) {
      this.controller?.abort()
      this.deps.emit({
        type: 'notice',
        message: `Stopped after ${repetitions} identical ${use.name} calls. Change approach before continuing.`
      })
      return errorResult(use.id, 'Repeated identical tool call stopped to prevent a loop.')
    }

    const result = signal.aborted
      ? errorResult(use.id, 'Interrupted by the user before this tool ran.')
      : await this.abortable(this.runOneTool(use, tools, signal), signal, use.id)
    if (repetitions >= 3) {
      result.content +=
        '\n\nWarning: this identical tool call is repeating and its result may not have changed. Try a different approach.'
    }
    this.deps.emit({ type: 'tool_end', messageId, toolUseId: use.id, result })
    return result
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
      // Bypass means nothing is put in front of the user — including the review
      // screen. Staging changes for approval while claiming to bypass approval
      // is just the same question asked somewhere else.
      editApproval: settings.bypassPermissions ? 'auto' : settings.editApproval,
      externalRoots: settings.externalRoots,
      sessionGrants: [...this.grants],
      signal,
      changes: this.changes,
      captureBefore: (absolutePath) => this.deps.beforeWrite(absolutePath),
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
        display: outcome.display,
        images: outcome.images
      }
    } catch (error) {
      if (signal.aborted) return errorResult(use.id, 'Interrupted by the user.')
      return errorResult(use.id, error instanceof Error ? error.message : String(error))
    }
  }

  /**
   * Stop has to mean stop.
   *
   * A tool is handed the abort signal and is expected to wind itself up, but
   * "expected to" is not a guarantee: a shell command whose grandchild still
   * holds the output pipe, an MCP server that stopped answering, a fetch with
   * no timeout. Any one of them would leave the loop waiting forever, the
   * session marked as running, and the stop button apparently doing nothing.
   *
   * So the wait is bounded. The tool keeps going in the background if it
   * insists — that cannot be helped from here — but the conversation is
   * released, and the result the model sees says plainly what happened.
   */
  private async abortable(
    work: Promise<ToolResultBlock>,
    signal: AbortSignal,
    toolUseId: string
  ): Promise<ToolResultBlock> {
    if (!signal.aborted && signal.addEventListener) {
      const abandoned = new Promise<ToolResultBlock>((resolve) => {
        const give = (): void => {
          setTimeout(
            () =>
              resolve(
                errorResult(
                  toolUseId,
                  'Stopped by the user. This tool did not finish, so its result is unknown.'
                )
              ),
            TOOL_ABANDON_MS
          ).unref?.()
        }
        if (signal.aborted) give()
        else signal.addEventListener('abort', give, { once: true })
      })

      return Promise.race([work, abandoned])
    }

    return work
  }

  private async requestPermission(
    request: Omit<PermissionRequest, 'id'>,
    signal: AbortSignal
  ): Promise<boolean> {
    const settings = this.deps.settings()
    const verdict = evaluatePermission({
      readOnly: settings.readOnly,
      bypassPermissions: settings.bypassPermissions,
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

  private shouldPauseForBudget(before: number, settings: Settings): boolean {
    const spent = this.totals.costUsd
    return (
      (settings.maxSessionCostUsd > 0 && spent >= settings.maxSessionCostUsd) ||
      (settings.maxTurnCostUsd > 0 && spent - before >= settings.maxTurnCostUsd)
    )
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

/** The last thing the user actually asked, to label a checkpoint with. */
function lastUserText(messages: Message[]): string {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (message.role !== 'user') continue

    const text = message.content
      .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
      .map((block) => block.text)
      .join(' ')
      .trim()
    if (text) return text
  }
  return ''
}

function stableStringify(value: unknown): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return JSON.stringify(value)
  return JSON.stringify(
    Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)))
  )
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
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, costUsd: 0 }
}

function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    reasoning: a.reasoning + b.reasoning,
    costUsd: a.costUsd + b.costUsd
  }
}

function deriveTitle(text: string): string {
  const clean = text.replace(/\s+/g, ' ').trim()
  if (!clean) return 'New session'
  const words = clean.split(' ').slice(0, 7).join(' ')
  return words.length > 60 ? `${words.slice(0, 57)}…` : words
}
