/**
 * Types shared between the Electron main process and the renderer.
 * Kept free of any runtime imports so both bundles can use it safely.
 */

// Type-only, so it is erased at compile time and adds no runtime dependency.
import type { Schedule } from './schedule'

export type { Schedule }

/* ------------------------------------------------------------------ */
/* Providers & models                                                  */
/* ------------------------------------------------------------------ */

/** Wire protocol a provider speaks. Almost every vendor speaks one of these. */
export type ProviderKind = 'anthropic' | 'openai' | 'google'

export interface ModelConfig {
  /** Model id sent on the wire, e.g. "claude-opus-4-5" or "gpt-4.1". */
  id: string
  /** Human label shown in the picker. Falls back to `id` when empty. */
  label: string
  contextWindow: number
  maxOutputTokens: number
  supportsTools: boolean
  supportsVision: boolean
  supportsThinking: boolean
  /** USD per 1M tokens. Optional — only used for the cost readout. */
  pricing?: { input: number; output: number; cacheRead?: number; cacheWrite?: number }

  /* --- per-model overrides; null/undefined means "use the global setting" --- */
  temperature?: number | null
  thinkingBudget?: number | null
  /**
   * Merged into the request body last, so it can set or override anything the
   * adapter produced — `top_p`, `top_k`, `reasoning_effort`, `repeat_penalty`,
   * `safety_settings`, vendor-specific flags. The escape hatch for endpoints
   * Forge does not know about.
   */
  extraBody?: Record<string, unknown>
  /**
   * Fraction of the context window to fill before older turns are summarised
   * away. Defaults to 0.75.
   */
  contextThreshold?: number | null
}

export interface ProviderConfig {
  id: string
  name: string
  kind: ProviderKind
  /** Base URL without a trailing slash, e.g. "https://api.openai.com/v1". */
  baseUrl: string
  /** Stored encrypted on disk when the OS keychain is available. */
  apiKey: string
  /** Extra headers merged into every request (e.g. OpenRouter attribution). */
  headers: Record<string, string>
  models: ModelConfig[]
  /** Built-in presets cannot be deleted, only edited. */
  builtin: boolean
  enabled: boolean
}

/** Fully qualified model reference: `${providerId}:${modelId}`. */
export type ModelRef = string

/* ------------------------------------------------------------------ */
/* Conversation                                                        */
/* ------------------------------------------------------------------ */

export interface TextBlock {
  type: 'text'
  text: string
}

export interface ThinkingBlock {
  type: 'thinking'
  text: string
}

export interface ToolUseBlock {
  type: 'tool_use'
  id: string
  name: string
  input: Record<string, unknown>
}

export interface ToolResultBlock {
  type: 'tool_result'
  toolUseId: string
  /** Text handed back to the model. */
  content: string
  isError: boolean
  /** Structured payload for rich rendering; never sent to the model. */
  display?: ToolDisplay
  /**
   * Images the tool produced, e.g. a screenshot.
   *
   * Carried alongside the result rather than inside it because only one of the
   * three provider protocols allows an image inside a tool result. They are
   * sent as ordinary image blocks in the same user turn, which all three accept.
   */
  images?: ImageBlock[]
}

export interface ImageBlock {
  type: 'image'
  mediaType: string
  /** Base64 without the data: prefix. */
  data: string
}

export type ContentBlock =
  | TextBlock
  | ThinkingBlock
  | ToolUseBlock
  | ToolResultBlock
  | ImageBlock

export interface Message {
  id: string
  role: 'user' | 'assistant'
  content: ContentBlock[]
  createdAt: number
  /** Which model produced this assistant turn. */
  model?: ModelRef
  usage?: TokenUsage
}

export interface TokenUsage {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  /** Thinking tokens, where the provider reports them separately. */
  reasoning: number
  costUsd: number
}

/** What a provider's rate-limit headers said on the last response. */
export interface RateLimit {
  providerId: string
  tokensRemaining?: number
  tokensLimit?: number
  requestsRemaining?: number
  /** ISO timestamp when the token bucket refills. */
  resetsAt?: string
  updatedAt: number
}

/**
 * Reasoning models, recognised from their id.
 *
 * Without this, a model added by hand or pulled in with "Fetch list" arrives
 * with thinking switched off, the effort control does nothing, and the feature
 * looks broken. The list errs towards recognising too much: sending a thinking
 * budget to a model that ignores it is harmless, while missing one silently
 * disables the feature.
 */
export function detectsThinking(modelId: string): boolean {
  const id = modelId.toLowerCase()
  return (
    /(^|\/)o[1-9](-|$)/.test(id) ||
    /gpt-5/.test(id) ||
    /claude-(opus|sonnet)-4/.test(id) ||
    /claude-3-7/.test(id) ||
    /gemini-2\.5/.test(id) ||
    /deepseek-(r1|reasoner)/.test(id) ||
    /qwq|qwen3/.test(id) ||
    /magistral|reasoning|thinking|-think/.test(id) ||
    /grok-(3|4).*(mini|reasoning)/.test(id)
  )
}

export function detectsVision(modelId: string): boolean {
  const id = modelId.toLowerCase()
  if (/embed|whisper|tts|moderation|rerank/.test(id)) return false
  return (
    /gpt-4|gpt-5|o[1-9](-|$)|claude|gemini|llava|pixtral|vision|qwen2?\.?5?-?vl/.test(id)
  )
}

/* ------------------------------------------------------------------ */
/* Tools                                                               */
/* ------------------------------------------------------------------ */

export interface ToolDisplay {
  /** One-line summary, e.g. "Read 128 lines". */
  summary: string
  /** Optional monospace body shown when the block is expanded. */
  body?: string
  /** Unified diff shown with +/- colouring. */
  diff?: string
  /** PNG or JPEG, base64, shown inline when kind is 'image'. */
  image?: { mediaType: string; data: string }
  kind: 'text' | 'diff' | 'list' | 'shell' | 'image'
}

/* ------------------------------------------------------------------ */
/* Modes & permissions                                                 */
/* ------------------------------------------------------------------ */

/**
 * Which layout the window uses. Purely visual — the agent has exactly the same
 * tools either way. `chat` gives the whole window to the conversation with
 * history down the side; `agent` is the editor, file tree and agent panel.
 *
 * Whether the agent may change anything is `readOnly`, deliberately separate:
 * wanting a bigger conversation view and wanting to hold the agent back are
 * unrelated wishes, and tying them together made one impossible without the other.
 */
export type InteractionMode = 'chat' | 'agent'

/**
 * `review` stages changes and collects them in the review screen (Cursor-like).
 * `ask`    opens a dialog before each edit (Claude Code-like).
 * `auto`   applies edits silently.
 */
export type EditApproval = 'review' | 'ask' | 'auto'

export type CommandApproval = 'ask' | 'auto'

export type ThemeName =
  | 'warm-dark'
  | 'dash'
  | 'true-black'
  | 'high-contrast'
  | 'midnight'
  | 'light'

/**
 * How the agent should approach the work. Each becomes a block of instruction
 * in the system prompt — the same tools, a different working style.
 */
export type AgentStance = 'default' | 'plan' | 'careful' | 'fast' | 'explain' | 'review'

/**
 * How hard the model should think before answering. One control across every
 * provider — it becomes a thinking-token budget on Anthropic and Gemini, and
 * `reasoning_effort` on OpenAI.
 */
export type ReasoningEffort = 'off' | 'low' | 'medium' | 'high' | 'max'

export const EFFORT_LEVELS: ReasoningEffort[] = ['off', 'low', 'medium', 'high', 'max']

const EFFORT_BUDGETS: Record<Exclude<ReasoningEffort, 'off' | 'max'>, number> = {
  low: 4_096,
  medium: 10_000,
  high: 24_000
}

/**
 * Thinking-token budget for providers that take a number.
 *
 * Always clamped below the model's output limit: the budget is spent out of
 * max_tokens, so a preset larger than the model can emit is rejected outright
 * by the API rather than quietly ignored.
 */
export function effortToBudget(effort: ReasoningEffort, maxOutputTokens: number): number {
  if (effort === 'off') return 0

  const ceiling = Math.max(1_024, Math.floor(maxOutputTokens * 0.75))
  if (effort === 'max') return ceiling
  return Math.min(EFFORT_BUDGETS[effort], ceiling)
}

export interface PermissionRequest {
  id: string
  toolName: string
  title: string
  /** What exactly is about to happen — command line, diff, path. */
  detail: string
  kind: 'edit' | 'write' | 'shell' | 'external' | 'mcp'
  /** Rule that would be persisted if the user picks "always allow". */
  suggestedRule: string
  /**
   * The user configured this exact call to be approved without asking, e.g. an
   * MCP tool listed in `autoApproveTools`.
   *
   * Deliberately not resolved to "allow" before this point: that standing
   * consent was given for interactive use, and an unattended run has to be able
   * to decide for itself whether it still applies.
   */
  preApproved?: boolean
  /**
   * This destroys something rather than changing it, so "apply edits without
   * asking" must not cover it.
   */
  destructive?: boolean
}

export type PermissionDecision =
  | { action: 'allow' }
  | { action: 'allow_always' }
  | { action: 'deny'; reason?: string }

/* ------------------------------------------------------------------ */
/* Pending changes (review screen)                                     */
/* ------------------------------------------------------------------ */

export interface PendingChange {
  id: string
  /** Path as shown to the user — relative inside the workspace, else absolute. */
  path: string
  absolutePath: string
  kind: 'create' | 'modify' | 'delete'
  /** Content before the very first change in this batch; null when created. */
  before: string | null
  after: string
  diff: string
  added: number
  removed: number
  updatedAt: number
}

/* ------------------------------------------------------------------ */
/* Skills                                                              */
/* ------------------------------------------------------------------ */

export interface Skill {
  /** Stable identifier the model passes to `use_skill`. */
  id: string
  /** One line, shown in the catalogue — this is what the model chooses on. */
  description: string
  category: string
  /** The full instructions, loaded only when the skill is actually used. */
  body: string
  source: 'builtin' | 'global' | 'project'
}

/* ------------------------------------------------------------------ */
/* MCP                                                                 */
/* ------------------------------------------------------------------ */

export type McpTransport = 'stdio' | 'http'

export interface McpServerConfig {
  id: string
  name: string
  transport: McpTransport
  /** stdio */
  command: string
  args: string[]
  env: Record<string, string>
  /** http */
  url: string
  headers: Record<string, string>
  enabled: boolean
  /** Tools listed here run without a prompt. */
  autoApproveTools: string[]
}

export interface McpToolInfo {
  name: string
  description: string
}

export interface McpServerStatus {
  id: string
  name: string
  state: 'stopped' | 'starting' | 'ready' | 'error'
  error?: string
  tools: McpToolInfo[]
}

/* ------------------------------------------------------------------ */
/* Git                                                                 */
/* ------------------------------------------------------------------ */

export type GitFileState = 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked' | 'conflict'

export interface GitFile {
  path: string
  state: GitFileState
  staged: boolean
  /** Both a staged and an unstaged change exist for this path. */
  partiallyStaged: boolean
}

export interface GitStatus {
  isRepo: boolean
  branch: string
  upstream: string | null
  ahead: number
  behind: number
  files: GitFile[]
  /** Populated only when `isRepo` is false and git failed for a real reason. */
  error?: string
}

export interface GitCommit {
  hash: string
  shortHash: string
  subject: string
  author: string
  relativeDate: string
}

/* ------------------------------------------------------------------ */
/* Agent streaming events (main -> renderer)                           */
/* ------------------------------------------------------------------ */

export type AgentEvent =
  | { type: 'turn_start'; messageId: string; model: ModelRef }
  | { type: 'text_delta'; messageId: string; text: string }
  | { type: 'thinking_delta'; messageId: string; text: string }
  | { type: 'tool_start'; messageId: string; block: ToolUseBlock }
  | { type: 'tool_end'; messageId: string; toolUseId: string; result: ToolResultBlock }
  | {
      type: 'turn_end'
      messageId: string
      usage: TokenUsage
      stopReason: string
      /** Wall-clock time this turn took, in milliseconds. */
      durationMs: number
    }
  /** A turn announced but never delivered — a retried request. Drop it. */
  | { type: 'turn_abandoned'; messageId: string }
  /**
   * The loop has stopped and `send()` is about to settle.
   *
   * The flags exist for callers with nobody watching: a scheduled task cannot
   * see an abort or a turn-cap cut-off any other way, and would otherwise
   * record a truncated or cancelled run as a clean success.
   */
  | { type: 'idle'; aborted?: boolean; truncated?: boolean }
  /** A message was typed mid-turn and is waiting for the next boundary. */
  | { type: 'queued'; text: string; pending: number }
  /** What the provider's rate-limit headers reported on the last response. */
  | { type: 'limits'; limit: RateLimit }
  | {
      type: 'context'
      /** Tokens the next request would carry. */
      used: number
      /** The active model's window, as configured. */
      window: number
      /** True before a provider has reported real usage for this conversation. */
      estimated: boolean
    }
  | { type: 'error'; message: string; detail?: string }
  | { type: 'notice'; message: string }
  | { type: 'file_changed'; path: string }
  | { type: 'changes'; changes: PendingChange[] }
  | { type: 'git_dirty' }

/* ------------------------------------------------------------------ */
/* Settings                                                           */
/* ------------------------------------------------------------------ */

export interface Settings {
  providers: ProviderConfig[]
  activeModel: ModelRef
  mode: InteractionMode
  /** Hard read-only: mutating tools are not offered to the model at all. */
  readOnly: boolean
  /**
   * Approve everything without asking — edits, commands, MCP tools and paths
   * outside the workspace. Deny rules and read-only still win over it.
   */
  bypassPermissions: boolean
  editApproval: EditApproval
  commandApproval: CommandApproval
  /** The working style injected into the system prompt. */
  stance: AgentStance
  /** Persisted "always allow" rules, e.g. "Bash(git status *)". */
  allowRules: string[]
  denyRules: string[]
  /** Directories outside the workspace the user has approved access to. */
  externalRoots: string[]
  mcpServers: McpServerConfig[]
  /** Ids of skills hidden from the model. */
  disabledSkills: string[]
  /** Interface language. Model replies follow whatever the user writes in. */
  language: 'en' | 'ru'
  /** Shown in the profile menu; local only, nothing is sent anywhere. */
  displayName: string
  /** Linked GitHub account. The token is encrypted like a provider key. */
  github: GithubLink
  voice: VoiceSettings
  /** Reusable prompts, offered under / in the composer. */
  prompts: SavedPrompt[]
  theme: ThemeName
  accent: string
  /** Zoom applied to the whole window, 0.7–1.6. 1 is native size. */
  uiScale: number
  editorFontSize: number
  chatFontSize: number
  fontFamily: string
  maxOutputTokens: number
  temperature: number
  effort: ReasoningEffort
  /** Extra instructions appended to the system prompt. */
  customInstructions: string
  showThinking: boolean
  autoSaveSessions: boolean
  /** Set once the first-run wizard has been finished or skipped. */
  setupCompleted: boolean
  /** Panel sizes and which panel was open, so the window comes back as you left it. */
  layout: LayoutState
  recentWorkspaces: string[]
}

export interface SavedPrompt {
  id: string
  /** Typed after a slash, so it is kept short and without spaces. */
  name: string
  description: string
  body: string
}

export interface VoiceSettings {
  /** Model that turns speech into text, as `providerId:modelId`. */
  inputModel: string
  /** Language hint for the recogniser, e.g. "ru". Empty means auto-detect. */
  inputLanguage: string
  /** Microphone deviceId, or empty for whatever the system considers default. */
  inputDevice: string
  /** Hold the mic button, or click once to start and again to stop. */
  pushToTalk: boolean
  /**
   * How replies are read aloud.
   *
   * `system` uses the operating system's voices: free, offline, immediate. The
   * API path is there for when those are not good enough, and costs money per
   * sentence, which is why it is not the default.
   */
  speak: 'off' | 'system' | 'api'
  /** Read every reply aloud, rather than only when asked. */
  autoSpeak: boolean
  /** System voice name, or the API voice id, depending on `speak`. */
  voiceName: string
  /** Playback rate for system voices, 0.5–2. */
  rate: number
  outputModel: string
}

/** What is stored for a linked GitHub account. */
export interface GithubLink {
  token: string
  login: string
  name: string
  avatarUrl: string
  scopes: string[]
}

/** What GitHub reports for a token, before it is stored. */
export interface GithubAccount {
  login: string
  name: string
  avatarUrl: string
  scopes: string[]
}

export interface LayoutState {
  sidebarWidth: number
  chatWidth: number
  chatSidebarWidth: number
  terminalHeight: number
  terminalOpen: boolean
  sidePanel: 'explorer' | 'git' | 'sessions' | 'search'
}

/* ------------------------------------------------------------------ */
/* Workspace & sessions                                                */
/* ------------------------------------------------------------------ */

export interface FileEntry {
  name: string
  path: string
  isDirectory: boolean
  size: number
}

export interface SessionSummary {
  id: string
  title: string
  updatedAt: number
  messageCount: number
}

export interface SessionRecord extends SessionSummary {
  messages: Message[]
  totals: TokenUsage
}

/* ------------------------------------------------------------------ */
/* Scheduled tasks                                                     */
/* ------------------------------------------------------------------ */

/**
 * A prompt the agent runs on its own, on a schedule, without anyone watching.
 *
 * Unattended runs are held to a stricter contract than a conversation you are
 * sitting in front of: there is nobody to answer a permission dialog, so what
 * the task may touch is decided here, when it is written, rather than later.
 */
export interface ScheduledTask {
  id: string
  name: string
  /** The message sent to the agent, exactly as if you had typed it. */
  prompt: string
  schedule: Schedule
  enabled: boolean
  /**
   * What an unattended run is allowed to do. Anything the agent asks for beyond
   * this is refused rather than queued for approval nobody will give.
   */
  permission: TaskPermission
  /** Model override; empty means whatever is active at run time. */
  model: string
  /** Raise an OS notification when a run finishes. */
  notify: boolean
  createdAt: number
  lastRunAt?: number
  /** Computed on save and after each run; null when the schedule can never fire. */
  nextRunAt: number | null
  lastRun?: TaskRunResult
}

/**
 * `read-only` is the default on purpose: a task that can only look is one you
 * can leave running for a week without thinking about it.
 */
export type TaskPermission = 'read-only' | 'edit' | 'full'

export interface TaskRunResult {
  startedAt: number
  durationMs: number
  /** `truncated` means it hit the tool-round cap with work still to do. */
  status: 'ok' | 'error' | 'cancelled' | 'truncated'
  /** The agent's closing message, trimmed for the list. */
  summary: string
  /** Present when status is 'error'. */
  error?: string
  usage: TokenUsage
  /** Conversation the run happened in, so it can be opened and read in full. */
  sessionId: string
}

export interface ProviderTestResult {
  ok: boolean
  message: string
  latencyMs?: number
  /** Models discovered from the provider's own catalogue endpoint. */
  models?: string[]
}
