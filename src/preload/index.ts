import { contextBridge, ipcRenderer, webFrame, webUtils } from 'electron'
import type {
  AgentEvent,
  FileEntry,
  GitCommit,
  GithubAccount,
  GitStatus,
  McpServerConfig,
  McpServerStatus,
  Message,
  PendingChange,
  PermissionDecision,
  PermissionRequest,
  ProviderConfig,
  ProviderTestResult,
  ScheduledTask,
  TaskRunResult,
  SessionRecord,
  SessionSummary,
  Settings,
  Skill,
  TokenUsage
} from '@shared/types'

interface Envelope<T> {
  ok: boolean
  value?: T
  error?: string
  detail?: string
}

/** Unwraps the main-process result envelope so callers can just await a value. */
async function call<T>(channel: string, ...args: unknown[]): Promise<T> {
  const result = (await ipcRenderer.invoke(channel, ...args)) as Envelope<T>
  if (!result?.ok) {
    const error = new Error(result?.error ?? `IPC call "${channel}" failed.`) as Error & {
      detail?: string
    }
    error.detail = result?.detail
    throw error
  }
  return result.value as T
}

/** Returns an unsubscribe function so React effects can clean up. */
function subscribe<T>(channel: string, handler: (payload: T) => void): () => void {
  const listener = (_event: unknown, payload: T): void => handler(payload)
  ipcRenderer.on(channel, listener)
  return () => {
    ipcRenderer.removeListener(channel, listener)
  }
}

export interface TerminalHandle {
  id: string
  backend: 'pty' | 'pipe'
  shell: string
  degradedReason?: string
}

export interface UpdateStatus {
  state: 'idle' | 'checking' | 'available' | 'downloading' | 'ready' | 'none' | 'error'
  version?: string
  notes?: string
  percent?: number
  message?: string
  /** False in development or when no publish target is configured. */
  supported: boolean
}

export interface Bootstrap {
  settings: Settings
  cwd: string
  workspaceName: string
  keysEncrypted: boolean
  settingsPath: string
  platform: string
  /** Shell the agent's run_command tool uses. */
  shellLabel: string
  /** Shell the terminal panel spawns, which is chosen separately. */
  terminalShell: string
  gitAvailable: boolean
  appVersion: string
  updates: UpdateStatus
}

export interface LiveSession {
  id: string
  title: string
  running: boolean
  messageCount: number
}

/** A stored task plus whether it is running right now. */
export type TaskEntry = ScheduledTask & { running: boolean }

export type TaskEvent =
  | { type: 'task_started'; taskId: string; taskName: string }
  | { type: 'task_finished'; taskId: string; taskName: string; result: TaskRunResult }
  | { type: 'tasks_changed'; taskName: string }

export interface LiveSource {
  id: string
  name: string
  kind: 'screen' | 'window'
  thumbnail: string
}

export interface LiveStatus {
  active: boolean
  sourceId: string
  sourceName: string
  access: 'watch' | 'control'
  controlUnavailable?: string
  actions: number
  startedAt: number
}

export interface LiveAction {
  kind: 'move' | 'click' | 'type' | 'key' | 'scroll' | 'drag'
  detail: string
  at: number
}

export interface BrowserState {
  url: string
  title: string
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  error?: string
}

export interface AgentState {
  id: string
  title: string
  messages: Message[]
  totals: TokenUsage
  running: boolean
  changes: PendingChange[]
}

const api = {
  bootstrap: () => call<Bootstrap>('app:bootstrap'),
  openExternal: (url: string) => call<boolean>('app:open-external', url),

  /**
   * Window zoom. Lives here because `webFrame` is not reachable from the
   * sandboxed renderer, and scaling the frame beats restyling every rule.
   */
  setZoom: (factor: number): void => {
    webFrame.setZoomFactor(Math.min(1.6, Math.max(0.7, factor)))
  },

  /**
   * Real filesystem path of a File from a paste or drop. `File.path` was
   * removed in Electron 32, so this is the only way to get it, and it has to
   * happen in the preload where `webUtils` lives.
   */
  pathForFile: (file: File): string => {
    try {
      return webUtils.getPathForFile(file)
    } catch {
      // Clipboard bitmaps and synthetic Files have no path on disk.
      return ''
    }
  },

  settings: {
    get: () => call<Settings>('settings:get'),
    set: (next: Settings) => call<Settings>('settings:set', next),
    /** Writes every provider, model and rule to a file; null when cancelled. */
    export: () => call<string | null>('settings:export'),
    import: () => call<Settings | null>('settings:import'),
    onChanged: (handler: (settings: Settings) => void) => subscribe('settings:changed', handler)
  },

  account: {
    /** Confirms a GitHub token and reports the account behind it. */
    verifyGithub: (token: string) => call<GithubAccount>('account:verify-github', token)
  },

  providers: {
    test: (provider: ProviderConfig) => call<ProviderTestResult>('provider:test', provider),
    listModels: (provider: ProviderConfig) => call<string[]>('provider:models', provider)
  },

  workspace: {
    pick: () => call<{ cwd: string; name: string } | null>('workspace:pick'),
    open: (target: string) => call<{ cwd: string; name: string }>('workspace:open', target),
    /** Native picker for attachments; absolute paths, empty if cancelled. */
    pickPaths: (kind: 'files' | 'folder') => call<string[]>('fs:pick', kind),
    list: (relative: string) => call<FileEntry[]>('fs:list', relative),
    read: (relative: string) => call<string>('fs:read', relative),
    write: (relative: string, content: string) => call<boolean>('fs:write', relative, content)
  },

  agent: {
    /** Omitting sessionId targets the active conversation. */
    send: (
      text: string,
      images: Array<{ mediaType: string; data: string }> = [],
      sessionId?: string
    ) => call<string>('agent:send', { text, images, sessionId }),
    abort: (sessionId?: string) => call<boolean>('agent:abort', sessionId),
    /** Opens a new conversation; existing ones keep running. */
    create: () => call<string>('agent:new'),
    activate: (sessionId: string) => call<boolean>('agent:activate', sessionId),
    close: (sessionId: string) => call<boolean>('agent:close', sessionId),
    state: (sessionId?: string) => call<AgentState | null>('agent:state', sessionId),
    live: () => call<LiveSession[]>('agent:live'),
    onEvent: (handler: (payload: { sessionId: string; event: AgentEvent }) => void) =>
      subscribe('agent:event', handler),
    onSessionsChanged: (handler: (sessions: LiveSession[]) => void) =>
      subscribe('sessions:changed', handler),
    onPermissionRequest: (handler: (request: PermissionRequest) => void) =>
      subscribe('permission:request', handler),
    /** Fires when a pending prompt is withdrawn, e.g. the turn was stopped. */
    onPermissionCancelled: (handler: (id: string) => void) =>
      subscribe('permission:cancel', handler),
    respondPermission: (id: string, decision: PermissionDecision) =>
      ipcRenderer.send('permission:respond', { id, decision })
  },

  live: {
    sources: () => call<LiveSource[]>('live:sources'),
    status: () => call<LiveStatus>('live:status'),
    start: (sourceId: string, access: 'watch' | 'control') =>
      call<LiveStatus>('live:start', { sourceId, access }),
    stop: () => call<LiveStatus>('live:stop'),
    /** One frame as a data URI, for the preview. */
    frame: () => call<string>('live:frame'),
    onStatus: (handler: (status: LiveStatus) => void) => subscribe('live:status', handler),
    onAction: (handler: (action: LiveAction) => void) => subscribe('live:action', handler)
  },

  browser: {
    /**
     * Tells the native view where the pane is and whether it is on screen.
     *
     * Bounds are in device-independent pixels, which is not what
     * getBoundingClientRect returns once the window is zoomed — the caller has
     * to scale, and `zoomFactor` is here so it can.
     */
    layout: (bounds: { x: number; y: number; width: number; height: number }, visible: boolean) =>
      ipcRenderer.send('browser:layout', { bounds, visible }),
    zoomFactor: (): number => webFrame.getZoomFactor(),
    navigate: (url: string) => call<BrowserState>('browser:navigate', url),
    state: () => call<BrowserState>('browser:state'),
    back: () => call<boolean>('browser:back'),
    forward: () => call<boolean>('browser:forward'),
    reload: () => call<boolean>('browser:reload'),
    stop: () => call<boolean>('browser:stop'),
    openExternal: () => call<boolean>('browser:open-external'),
    clear: () => call<boolean>('browser:clear'),
    onState: (handler: (state: BrowserState) => void) => subscribe('browser:state', handler),
    /** The agent opened a page and the pane should come to the front. */
    onReveal: (handler: () => void) => subscribe('browser:reveal', handler)
  },

  tasks: {
    list: () => call<TaskEntry[]>('tasks:list'),
    /** Creates when the task has no id, updates when it does. */
    save: (task: Partial<ScheduledTask>) => call<ScheduledTask>('tasks:save', task),
    remove: (id: string) => call<boolean>('tasks:remove', id),
    /** Runs now, ignoring the schedule; resolves when the run finishes. */
    run: (id: string) => call<TaskRunResult | null>('tasks:run', id),
    onChanged: (handler: (tasks: ScheduledTask[]) => void) => subscribe('tasks:changed', handler),
    onEvent: (handler: (event: TaskEvent) => void) => subscribe('tasks:event', handler),
    /** Live agent output from a running task, for showing progress. */
    onActivity: (handler: (payload: { taskId: string; event: AgentEvent }) => void) =>
      subscribe('tasks:activity', handler),
    /** Fires when a notification is clicked; carries the run's conversation. */
    onOpenSession: (handler: (sessionId: string) => void) =>
      subscribe('tasks:open-session', handler)
  },

  changes: {
    list: (sessionId?: string) => call<PendingChange[]>('changes:list', sessionId),
    accept: (id: string, sessionId?: string) => call<boolean>('changes:accept', id, sessionId),
    acceptAll: (sessionId?: string) => call<boolean>('changes:acceptAll', sessionId),
    reject: (id: string, sessionId?: string) => call<boolean>('changes:reject', id, sessionId),
    rejectAll: (sessionId?: string) => call<boolean>('changes:rejectAll', sessionId)
  },

  git: {
    status: () => call<GitStatus>('git:status'),
    diff: (file: string, staged: boolean) => call<string>('git:diff', file, staged),
    stage: (paths: string[]) => call<boolean>('git:stage', paths),
    unstage: (paths: string[]) => call<boolean>('git:unstage', paths),
    discard: (paths: string[]) => call<boolean>('git:discard', paths),
    commit: (message: string, stageAll: boolean) => call<string>('git:commit', message, stageAll),
    log: (limit = 20) => call<GitCommit[]>('git:log', limit),
    branches: () => call<string[]>('git:branches'),
    checkout: (branch: string) => call<boolean>('git:checkout', branch)
  },

  mcp: {
    status: () => call<McpServerStatus[]>('mcp:status'),
    restart: (id: string) => call<McpServerStatus[]>('mcp:restart', id),
    sync: (servers: McpServerConfig[]) => call<McpServerStatus[]>('mcp:sync', servers),
    onStatus: (handler: (statuses: McpServerStatus[]) => void) => subscribe('mcp:status', handler)
  },

  sessions: {
    list: () => call<Array<SessionSummary & { running: boolean; open: boolean }>>('sessions:list'),
    load: (id: string) => call<SessionRecord>('sessions:load', id),
    remove: (id: string) => call<boolean>('sessions:remove', id)
  },

  terminal: {
    create: (cols: number, rows: number) => call<TerminalHandle>('terminal:create', { cols, rows }),
    write: (id: string, data: string) => ipcRenderer.send('terminal:write', { id, data }),
    resize: (id: string, cols: number, rows: number) =>
      ipcRenderer.send('terminal:resize', { id, cols, rows }),
    kill: (id: string) => call<boolean>('terminal:kill', id),
    onData: (handler: (payload: { id: string; data: string }) => void) =>
      subscribe('terminal:data', handler)
  },

  skills: {
    list: () => call<Skill[]>('skills:list'),
    reload: () => call<Skill[]>('skills:reload'),
    openFolder: (scope: 'global' | 'project') => call<string>('skills:open-folder', scope)
  },

  updates: {
    check: () => call<UpdateStatus>('updates:check'),
    download: () => call<boolean>('updates:download'),
    install: () => call<boolean>('updates:install'),
    onStatus: (handler: (status: UpdateStatus) => void) => subscribe('updates:status', handler)
  },

  /** Application-menu commands, so accelerators drive the same code paths. */
  menu: {
    on: (handler: (command: string, payload?: unknown) => void) => {
      const channels = [
        'menu:open-folder',
        'menu:new-session',
        'menu:save',
        'menu:settings',
        'menu:mode',
        'menu:toggle-sidebar',
        'menu:toggle-terminal',
        'menu:review',
        'menu:git',
        'menu:check-updates'
      ]
      const offs = channels.map((channel) =>
        subscribe(channel, (payload: unknown) => handler(channel, payload))
      )
      return () => {
        for (const off of offs) off()
      }
    },
    onWorkspaceChanged: (handler: (cwd: string) => void) => subscribe('workspace:changed', handler)
  }
}

contextBridge.exposeInMainWorld('forge', api)

export type ForgeApi = typeof api
