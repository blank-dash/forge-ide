import { create } from 'zustand'
import { DEFAULT_SETTINGS } from '@shared/defaults'
import type {
  AgentEvent,
  GitStatus,
  LayoutState,
  McpServerStatus,
  PendingChange,
  PermissionRequest,
  Settings,
  TokenUsage,
  ToolResultBlock,
  ToolUseBlock
} from '@shared/types'
import type { Attachment } from './attachments'
import type { Bootstrap, LiveStatus } from '../preload'
import { reduceSession } from './session-reducer'

export type RenderBlock =
  | { kind: 'text'; text: string }
  | { kind: 'thinking'; text: string }
  | { kind: 'tool'; use: ToolUseBlock; result?: ToolResultBlock }

export interface ChatEntry {
  id: string
  role: 'user' | 'assistant'
  blocks: RenderBlock[]
  streaming: boolean
  model?: string
  usage?: TokenUsage
  /** Wall-clock time the turn took, in milliseconds. */
  durationMs?: number
  /** Thumbnails and chips shown under a user turn that carried attachments. */
  attachments?: Attachment[]
}

export interface ChatError {
  id: string
  message: string
  detail?: string
}

export interface Notice {
  id: string
  message: string
}

export interface Tab {
  path: string
  content: string
  savedContent: string
}

/** Everything that belongs to one conversation rather than to the window. */
export interface SessionView {
  entries: ChatEntry[]
  errors: ChatError[]
  notices: Notice[]
  running: boolean
  totals: TokenUsage
  changes: PendingChange[]
  queuedCount: number
  context: { used: number; window: number; estimated: boolean } | null
}

export type SidePanel = 'explorer' | 'git' | 'sessions' | 'search'
export type MainView = 'editor' | 'review'
/** Which pane the full-window chat view is showing. */
export type ChatPane = 'chats' | 'dashboard' | 'tasks' | 'browser' | 'live' | 'checkpoints'

interface UiState {
  sidebarWidth: number
  chatWidth: number
  /** History rail in the full-window chat view. */
  chatSidebarWidth: number
  terminalHeight: number
  terminalOpen: boolean
  settingsOpen: boolean
  settingsSection: string
  sidePanel: SidePanel
  mainView: MainView
  chatPane: ChatPane
  /** Which overlay picker is open, if any. */
  picker: 'none' | 'files' | 'commands' | 'symbols'
}

interface State {
  ready: boolean
  bootstrap: Bootstrap | null
  settings: Settings

  entries: ChatEntry[]
  errors: ChatError[]
  notices: Notice[]
  running: boolean
  totals: TokenUsage
  permission: PermissionRequest | null
  /** Id of the conversation currently loaded in the main process. */
  sessionId: string | null
  sessionModel: string | null
  /** Messages typed mid-turn that the agent has not picked up yet. */
  queuedCount: number
  /** How full the model's context window is for the next request. */
  context: { used: number; window: number; estimated: boolean } | null

  changes: PendingChange[]
  /** Conversations running in the background, keyed by session id. */
  background: Record<string, SessionView>
  /** Ids currently mid-turn, including ones not on screen. */
  liveSessions: string[]
  /** Scheduled tasks running right now, so the rail can show a count. */
  runningTasks: string[]
  /** Live-mode session, or null when nothing is being shared. */
  live: LiveStatus | null
  /**
   * A request to scroll the editor somewhere.
   *
   * Carries a timestamp because asking for the same line twice must still move
   * the editor — a bare line number would look unchanged and be ignored.
   */
  revealRequest: { line: number; at: number } | null
  /** Text on its way into the composer from somewhere else. */
  composerInsert: { text: string; at: number } | null
  git: GitStatus | null
  mcp: McpServerStatus[]

  tabs: Tab[]
  activeTab: string | null
  /** Absolute paths the agent touched this session, for tree decoration. */
  changedFiles: Set<string>
  /** Bumped whenever something on disk changed, so panels can refresh. */
  fsRevision: number
  /** Bumped by the File → Save menu item, which the editor watches. */
  saveRequest: number

  ui: UiState

  init(bootstrap: Bootstrap): void
  resetWorkspace(bootstrap: Bootstrap): void
  setSettings(settings: Settings): void
  saveSettings(patch: Partial<Settings>): Promise<void>
  patchUi(patch: Partial<UiState>): void

  pushUser(text: string, attachments?: Attachment[]): void
  removeEntry(id: string): void
  applyEvent(event: AgentEvent, sessionId?: string): void
  pushError(message: string, detail?: string): void
  dismissError(id: string): void
  dismissNotice(id: string): void
  /** A one-line message from the app itself, not from the agent. */
  pushNotice(message: string): void
  clearChat(): void
  loadState(payload: {
    entries: ChatEntry[]
    totals: TokenUsage
    changes: PendingChange[]
    sessionId: string
  }): void
  setPermission(request: PermissionRequest | null): void
  setSessionId(id: string | null): void
  setSessionModel(model: string | null): void
  /** Moves the on-screen conversation aside and brings another one forward. */
  switchSession(id: string, view?: SessionView): void
  setLiveSessions(sessions: Array<{ id: string; running: boolean }>): void
  setTaskRunning(taskId: string, running: boolean): void
  setLive(status: LiveStatus | null): void
  /** Scrolls the open editor to a line, for the outline picker. */
  revealLine(line: number): void
  /** Writes the conversation out as Markdown. */
  exportConversation(): Promise<void>
  /**
   * Puts text into the composer from elsewhere — the editor's Ctrl+L and
   * Ctrl+K, mostly. Carries a stamp so the same text twice still arrives.
   */
  appendToComposer(text: string): void

  setGit(status: GitStatus | null): void
  setMcp(statuses: McpServerStatus[]): void
  setChanges(changes: PendingChange[]): void

  openTab(path: string, content: string): void
  closeTab(path: string): void
  setActiveTab(path: string): void
  updateTab(path: string, content: string): void
  markTabSaved(path: string): void
  reloadTab(path: string, content: string): void
  requestSave(): void
}

const EMPTY_USAGE: TokenUsage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  reasoning: 0,
  costUsd: 0
}

export const useStore = create<State>((set, get) => ({
  ready: false,
  bootstrap: null,
  settings: DEFAULT_SETTINGS,

  entries: [],
  errors: [],
  notices: [],
  running: false,
  totals: EMPTY_USAGE,
  permission: null,
  sessionId: null,
  sessionModel: null,
  queuedCount: 0,
  context: null,

  changes: [],
  background: {},
  liveSessions: [],
  runningTasks: [],
  live: null,
  revealRequest: null,
  composerInsert: null,
  git: null,
  mcp: [],

  tabs: [],
  activeTab: null,
  changedFiles: new Set(),
  fsRevision: 0,
  saveRequest: 0,

  ui: {
    sidebarWidth: 240,
    chatWidth: 470,
    chatSidebarWidth: 262,
    terminalHeight: 220,
    terminalOpen: false,
    settingsOpen: false,
    settingsSection: 'providers',
    sidePanel: 'explorer',
    mainView: 'editor',
    chatPane: 'chats',
    picker: 'none'
  },

  init: (bootstrap) =>
    set((state) => ({
      bootstrap,
      settings: bootstrap.settings,
      ready: true,
      // Come back with the panels the user left open, at the sizes they set.
      ui: { ...state.ui, ...bootstrap.settings.layout }
    })),
  setSettings: (settings) => set({ settings }),

  resetWorkspace: (bootstrap) =>
    set({
      ready: true,
      bootstrap,
      settings: bootstrap.settings,
      entries: [],
      errors: [],
      notices: [],
      running: false,
      totals: EMPTY_USAGE,
      permission: null,
      sessionId: null,
      sessionModel: null,
      queuedCount: 0,
      context: null,
      changes: [],
      background: {},
      liveSessions: [],
      runningTasks: [],
      live: null,
      revealRequest: null,
      composerInsert: null,
      git: null,
      mcp: [],
      tabs: [],
      activeTab: null,
      changedFiles: new Set(),
      fsRevision: 0,
      saveRequest: 0,
      ui: { ...stateUi(), ...bootstrap.settings.layout }
    }),

  saveSettings: async (patch) => {
    const next = { ...get().settings, ...patch }
    // Optimistic: the UI must not lag behind a toggle the user just flipped.
    set({ settings: next })
    try {
      set({ settings: await window.forge.settings.set(next) })
    } catch (error) {
      get().pushError(`Could not save settings: ${(error as Error).message}`)
    }
  },

  patchUi: (patch) => {
    set((state) => ({ ui: { ...state.ui, ...patch } }))
    if (LAYOUT_KEYS.some((key) => key in patch)) scheduleLayoutSave()
  },

  pushUser: (text, attachments) =>
    set((state) => ({
      running: true,
      entries: [
        ...state.entries,
        {
          id: `user-${Date.now()}-${state.entries.length}`,
          role: 'user',
          blocks: [{ kind: 'text', text }],
          streaming: false,
          attachments: attachments?.length ? attachments : undefined
        }
      ]
    })),

  removeEntry: (id) =>
    set((state) => ({ entries: state.entries.filter((entry) => entry.id !== id) })),

  applyEvent: (event, sessionId) => {
    // An event for a conversation that is not on screen updates its stored
    // view instead, so leaving a chat to work does not lose its output.
    const active = get().sessionId
    if (sessionId && active && sessionId !== active) {
      set((state) => ({
        background: {
          ...state.background,
          [sessionId]: reduceSession(state.background[sessionId] ?? emptyView(), event)
        }
      }))
      return
    }

    if (event.type === 'file_changed') {
      set((state) => {
        const next = new Set(state.changedFiles)
        next.add(event.path)
        return { changedFiles: next, fsRevision: state.fsRevision + 1 }
      })
      return
    }
    if (event.type === 'git_dirty') {
      set((state) => ({ fsRevision: state.fsRevision + 1 }))
      return
    }

    set((state) => {
      const view: SessionView = {
        entries: state.entries,
        errors: state.errors,
        notices: state.notices,
        running: state.running,
        totals: state.totals,
        changes: state.changes,
        queuedCount: state.queuedCount,
        context: state.context
      }
      const next = reduceSession(view, event)
      return {
        entries: next.entries,
        errors: next.errors,
        notices: next.notices,
        running: next.running,
        totals: next.totals,
        changes: next.changes,
        queuedCount: next.queuedCount,
        context: next.context,
        permission: event.type === 'idle' ? null : state.permission
      }
    })
    return
  },

  pushError: (message, detail) =>
    set((state) => ({
      errors: [...state.errors, { id: `err-${Date.now()}-${state.errors.length}`, message, detail }]
    })),

  dismissError: (id) => set((state) => ({ errors: state.errors.filter((e) => e.id !== id) })),
  dismissNotice: (id) => set((state) => ({ notices: state.notices.filter((n) => n.id !== id) })),

  pushNotice: (message) =>
    set((state) => ({
      notices: [...state.notices.slice(-3), { id: `ui-${Date.now()}-${message.length}`, message }]
    })),

  clearChat: () =>
    set({
      entries: [],
      errors: [],
      notices: [],
      totals: EMPTY_USAGE,
      changes: [],
      context: null
    }),

  loadState: (payload) =>
    set({
      entries: payload.entries,
      totals: payload.totals,
      changes: payload.changes,
      sessionId: payload.sessionId,
      errors: [],
      notices: [],
      // A reloaded conversation has no measured context until it is used again.
      context: null
    }),

  setPermission: (permission) => set({ permission }),
  setSessionId: (sessionId) => set({ sessionId }),
  setSessionModel: (sessionModel: string | null) => set({ sessionModel }),

  switchSession: (id, view) =>
    set((state) => {
      const background = { ...state.background }
      // Park the conversation leaving the screen so it keeps accumulating.
      if (state.sessionId && state.sessionId !== id) {
        background[state.sessionId] = {
          entries: state.entries,
          errors: state.errors,
          notices: state.notices,
          running: state.running,
          totals: state.totals,
          changes: state.changes,
          queuedCount: state.queuedCount,
          context: state.context
        }
      }

      const next = view ?? background[id] ?? emptyView()
      delete background[id]

      return {
        background,
        sessionId: id,
        entries: next.entries,
        errors: next.errors,
        notices: next.notices,
        running: next.running,
        totals: next.totals,
        changes: next.changes,
        queuedCount: next.queuedCount,
        context: next.context
      }
    }),

  setLive: (live) => set({ live }),

  revealLine: (line) => set({ revealRequest: { line, at: Date.now() } }),

  appendToComposer: (text) => set({ composerInsert: { text, at: Date.now() } }),

  exportConversation: async () => {
    const state = get()
    const markdown = conversationMarkdown(state.entries, state.totals)
    const saved = await window.forge.workspace.exportText(markdown).catch((error) => {
      state.pushError(`Export failed: ${(error as Error).message}`)
      return null
    })
    if (saved) state.pushNotice(`Saved to ${saved}`)
  },

  setTaskRunning: (taskId, running) =>
    set((state) => ({
      runningTasks: running
        ? state.runningTasks.includes(taskId)
          ? state.runningTasks
          : [...state.runningTasks, taskId]
        : state.runningTasks.filter((id) => id !== taskId)
    })),

  setLiveSessions: (sessions) =>
    set((state) => ({
      liveSessions: sessions.filter((entry) => entry.running).map((entry) => entry.id),
      // A background turn that finished has to stop showing as running.
      background: Object.fromEntries(
        Object.entries(state.background).map(([id, view]) => [
          id,
          { ...view, running: sessions.find((entry) => entry.id === id)?.running ?? view.running }
        ])
      )
    })),
  setGit: (git) => set({ git }),
  setMcp: (mcp) => set({ mcp }),
  setChanges: (changes) => set({ changes }),

  openTab: (path, content) =>
    set((state) => {
      if (state.tabs.some((tab) => tab.path === path)) return { activeTab: path }
      return {
        tabs: [...state.tabs, { path, content, savedContent: content }],
        activeTab: path,
        ui: { ...state.ui, mainView: 'editor' }
      }
    }),

  closeTab: (path) =>
    set((state) => {
      const tabs = state.tabs.filter((tab) => tab.path !== path)
      const activeTab = state.activeTab === path ? (tabs.at(-1)?.path ?? null) : state.activeTab
      return { tabs, activeTab }
    }),

  setActiveTab: (path) =>
    set((state) => ({ activeTab: path, ui: { ...state.ui, mainView: 'editor' } })),

  updateTab: (path, content) =>
    set((state) => ({
      tabs: state.tabs.map((tab) => (tab.path === path ? { ...tab, content } : tab))
    })),

  markTabSaved: (path) =>
    set((state) => ({
      tabs: state.tabs.map((tab) =>
        tab.path === path ? { ...tab, savedContent: tab.content } : tab
      )
    })),

  reloadTab: (path, content) =>
    set((state) => ({
      tabs: state.tabs.map((tab) =>
        tab.path === path ? { ...tab, content, savedContent: content } : tab
      )
    })),

  requestSave: () => set((state) => ({ saveRequest: state.saveRequest + 1 }))
}))

const LAYOUT_KEYS = [
  'sidebarWidth',
  'chatWidth',
  'chatSidebarWidth',
  'terminalHeight',
  'terminalOpen',
  'sidePanel'
] as const satisfies ReadonlyArray<keyof LayoutState>

let layoutTimer: ReturnType<typeof setTimeout> | null = null

/**
 * Dragging a divider fires continuously, so the layout is written once the
 * user stops rather than on every pixel.
 */
function scheduleLayoutSave(): void {
  if (layoutTimer) clearTimeout(layoutTimer)
  layoutTimer = setTimeout(() => {
    layoutTimer = null
    const state = useStore.getState()
    if (!state.ready) return

    const layout: LayoutState = {
      sidebarWidth: state.ui.sidebarWidth,
      chatWidth: state.ui.chatWidth,
      chatSidebarWidth: state.ui.chatSidebarWidth,
      terminalHeight: state.ui.terminalHeight,
      terminalOpen: state.ui.terminalOpen,
      sidePanel: state.ui.sidePanel
    }

    if (JSON.stringify(layout) === JSON.stringify(state.settings.layout)) return
    void state.saveSettings({ layout })
  }, 600)
}

export function stateUi(): UiState {
  return {
    sidebarWidth: 240,
    chatWidth: 470,
    chatSidebarWidth: 262,
    terminalHeight: 220,
    terminalOpen: false,
    settingsOpen: false,
    settingsSection: 'providers',
    sidePanel: 'explorer',
    mainView: 'editor',
    chatPane: 'chats',
    picker: 'none'
  }
}

export function emptyView(): SessionView {
  return {
    entries: [],
    errors: [],
    notices: [],
    running: false,
    totals: EMPTY_USAGE,
    changes: [],
    queuedCount: 0,
    context: null
  }
}

/**
 * A conversation as Markdown.
 *
 * Written for reading and pasting elsewhere, so tool calls are collapsed to one
 * line each rather than reproduced in full — a transcript of every diff is not
 * something anyone wants to scroll through, and the files are right there.
 */
export function conversationMarkdown(entries: ChatEntry[], totals: TokenUsage): string {
  const lines: string[] = ['# Conversation', '']

  for (const entry of entries) {
    lines.push(entry.role === 'user' ? '## You' : '## Agent')
    if (entry.model) lines.push(`_${entry.model}_`, '')

    for (const block of entry.blocks) {
      if (block.kind === 'text') lines.push(block.text.trim(), '')
      else if (block.kind === 'thinking') continue
      else if (block.kind === 'tool') {
        const status = block.result?.isError ? 'failed' : 'ok'
        lines.push(`- \`${block.use.name}\` — ${block.result?.display?.summary ?? status}`, '')
      }
    }
  }

  if (totals.input || totals.output) {
    lines.push(
      '---',
      '',
      `${totals.input.toLocaleString()} in · ${totals.output.toLocaleString()} out` +
        (totals.costUsd > 0 ? ` · $${totals.costUsd.toFixed(4)}` : '')
    )
  }

  const text = lines.join(String.fromCharCode(10))
  // Collapses the blank lines that empty tool blocks leave behind.
  return text.replace(new RegExp('\n{3,}', 'g'), '\n\n')
}
