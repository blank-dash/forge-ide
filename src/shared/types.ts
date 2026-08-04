/**
 * Types shared between the Electron main process and the renderer.
 * Kept free of any runtime imports so both bundles can use it safely.
 */

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
  costUsd: number
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
  kind: 'text' | 'diff' | 'list' | 'shell'
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
  | { type: 'turn_end'; messageId: string; usage: TokenUsage; stopReason: string }
  /** A turn announced but never delivered — a retried request. Drop it. */
  | { type: 'turn_abandoned'; messageId: string }
  | { type: 'idle' }
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
  editApproval: EditApproval
  commandApproval: CommandApproval
  /** Persisted "always allow" rules, e.g. "Bash(git status *)". */
  allowRules: string[]
  denyRules: string[]
  /** Directories outside the workspace the user has approved access to. */
  externalRoots: string[]
  mcpServers: McpServerConfig[]
  theme: 'dark' | 'light'
  accent: string
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

export interface LayoutState {
  sidebarWidth: number
  chatWidth: number
  chatSidebarWidth: number
  terminalHeight: number
  terminalOpen: boolean
  sidePanel: 'explorer' | 'git' | 'sessions'
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

export interface ProviderTestResult {
  ok: boolean
  message: string
  latencyMs?: number
  /** Models discovered from the provider's own catalogue endpoint. */
  models?: string[]
}
