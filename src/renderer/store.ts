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
import type { Bootstrap } from '../preload'

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

export type SidePanel = 'explorer' | 'git' | 'sessions'
export type MainView = 'editor' | 'review'

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
  /** Messages typed mid-turn that the agent has not picked up yet. */
  queuedCount: number
  /** How full the model's context window is for the next request. */
  context: { used: number; window: number; estimated: boolean } | null

  changes: PendingChange[]
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
  setSettings(settings: Settings): void
  saveSettings(patch: Partial<Settings>): Promise<void>
  patchUi(patch: Partial<UiState>): void

  pushUser(text: string, attachments?: Attachment[]): void
  applyEvent(event: AgentEvent): void
  pushError(message: string, detail?: string): void
  dismissError(id: string): void
  dismissNotice(id: string): void
  clearChat(): void
  loadState(payload: {
    entries: ChatEntry[]
    totals: TokenUsage
    changes: PendingChange[]
    sessionId: string
  }): void
  setPermission(request: PermissionRequest | null): void
  setSessionId(id: string | null): void

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

const EMPTY_USAGE: TokenUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0 }
const MAX_NOTICES = 4

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
  queuedCount: 0,
  context: null,

  changes: [],
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
    mainView: 'editor'
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

  applyEvent: (event) => {
    switch (event.type) {
      case 'turn_start':
        set((state) => ({
          running: true,
          entries: [
            ...state.entries,
            {
              id: event.messageId,
              role: 'assistant',
              blocks: [],
              streaming: true,
              model: event.model
            }
          ]
        }))
        break

      case 'text_delta':
        set((state) => ({
          entries: mapEntry(state.entries, event.messageId, (entry) => ({
            ...entry,
            blocks: appendText(entry.blocks, 'text', event.text)
          }))
        }))
        break

      case 'thinking_delta':
        set((state) => ({
          entries: mapEntry(state.entries, event.messageId, (entry) => ({
            ...entry,
            blocks: appendText(entry.blocks, 'thinking', event.text)
          }))
        }))
        break

      case 'tool_start':
        set((state) => ({
          entries: mapEntry(state.entries, event.messageId, (entry) => ({
            ...entry,
            blocks: [...entry.blocks, { kind: 'tool', use: event.block }]
          }))
        }))
        break

      case 'tool_end':
        set((state) => ({
          entries: mapEntry(state.entries, event.messageId, (entry) => ({
            ...entry,
            blocks: entry.blocks.map((block) =>
              block.kind === 'tool' && block.use.id === event.toolUseId
                ? { ...block, result: event.result }
                : block
            )
          }))
        }))
        break

      case 'turn_end':
        set((state) => ({
          totals: addUsage(state.totals, event.usage),
          entries: mapEntry(state.entries, event.messageId, (entry) => ({
            ...entry,
            streaming: false,
            usage: event.usage
          }))
        }))
        break

      case 'queued':
        set({ queuedCount: event.pending })
        break

      case 'turn_abandoned':
        set((state) => ({
          entries: state.entries.filter((entry) => entry.id !== event.messageId)
        }))
        break

      case 'idle':
        set((state) => ({
          running: false,
          permission: null,
          queuedCount: 0,
          // A turn that produced nothing leaves an empty bubble behind.
          entries: state.entries
            .filter((entry) => entry.role === 'user' || entry.blocks.length > 0)
            .map((entry) => ({ ...entry, streaming: false }))
        }))
        break

      case 'context':
        set({
          context: { used: event.used, window: event.window, estimated: event.estimated }
        })
        break

      case 'error':
        get().pushError(event.message, event.detail)
        break

      case 'notice':
        set((state) => ({
          notices: [
            ...state.notices.slice(-(MAX_NOTICES - 1)),
            { id: `note-${Date.now()}-${state.notices.length}`, message: event.message }
          ]
        }))
        break

      case 'file_changed':
        set((state) => {
          const next = new Set(state.changedFiles)
          next.add(event.path)
          return { changedFiles: next, fsRevision: state.fsRevision + 1 }
        })
        break

      case 'changes':
        set({ changes: event.changes })
        break

      case 'git_dirty':
        set((state) => ({ fsRevision: state.fsRevision + 1 }))
        break
    }
  },

  pushError: (message, detail) =>
    set((state) => ({
      errors: [...state.errors, { id: `err-${Date.now()}-${state.errors.length}`, message, detail }]
    })),

  dismissError: (id) => set((state) => ({ errors: state.errors.filter((e) => e.id !== id) })),
  dismissNotice: (id) => set((state) => ({ notices: state.notices.filter((n) => n.id !== id) })),

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

function mapEntry(
  entries: ChatEntry[],
  id: string,
  fn: (entry: ChatEntry) => ChatEntry
): ChatEntry[] {
  return entries.map((entry) => (entry.id === id ? fn(entry) : entry))
}

/** Streams text into the trailing block of the same kind, or starts a new one. */
function appendText(
  blocks: RenderBlock[],
  kind: 'text' | 'thinking',
  text: string
): RenderBlock[] {
  const last = blocks.at(-1)
  if (last && last.kind === kind) {
    return [...blocks.slice(0, -1), { kind, text: last.text + text }]
  }
  return [...blocks, { kind, text }]
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
