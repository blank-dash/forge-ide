import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type {
  AgentEvent,
  FileEntry,
  GitCommit,
  GitStatus,
  McpServerConfig,
  McpServerStatus,
  Message,
  PendingChange,
  PermissionDecision,
  PermissionRequest,
  ProviderConfig,
  ProviderTestResult,
  SessionRecord,
  SessionSummary,
  Settings,
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
  shellLabel: string
  gitAvailable: boolean
  appVersion: string
  updates: UpdateStatus
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
    onChanged: (handler: (settings: Settings) => void) => subscribe('settings:changed', handler)
  },

  providers: {
    test: (provider: ProviderConfig) => call<ProviderTestResult>('provider:test', provider),
    listModels: (provider: ProviderConfig) => call<string[]>('provider:models', provider)
  },

  workspace: {
    pick: () => call<{ cwd: string; name: string } | null>('workspace:pick'),
    open: (target: string) => call<{ cwd: string; name: string }>('workspace:open', target),
    list: (relative: string) => call<FileEntry[]>('fs:list', relative),
    read: (relative: string) => call<string>('fs:read', relative),
    write: (relative: string, content: string) => call<boolean>('fs:write', relative, content)
  },

  agent: {
    send: (text: string, images: Array<{ mediaType: string; data: string }> = []) =>
      call<boolean>('agent:send', { text, images }),
    abort: () => call<boolean>('agent:abort'),
    reset: () => call<boolean>('agent:reset'),
    state: () => call<AgentState>('agent:state'),
    onEvent: (handler: (event: AgentEvent) => void) => subscribe('agent:event', handler),
    onPermissionRequest: (handler: (request: PermissionRequest) => void) =>
      subscribe('permission:request', handler),
    respondPermission: (id: string, decision: PermissionDecision) =>
      ipcRenderer.send('permission:respond', { id, decision })
  },

  changes: {
    list: () => call<PendingChange[]>('changes:list'),
    accept: (id: string) => call<boolean>('changes:accept', id),
    acceptAll: () => call<boolean>('changes:acceptAll'),
    reject: (id: string) => call<boolean>('changes:reject', id),
    rejectAll: () => call<boolean>('changes:rejectAll')
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
    list: () => call<SessionSummary[]>('sessions:list'),
    load: (id: string) => call<SessionRecord>('sessions:load', id),
    remove: (id: string) => call<boolean>('sessions:remove', id)
  },

  terminal: {
    create: (cols: number, rows: number) =>
      call<TerminalHandle>('terminal:create', { cols, rows }),
    write: (id: string, data: string) => ipcRenderer.send('terminal:write', { id, data }),
    resize: (id: string, cols: number, rows: number) =>
      ipcRenderer.send('terminal:resize', { id, cols, rows }),
    kill: (id: string) => call<boolean>('terminal:kill', id),
    onData: (handler: (payload: { id: string; data: string }) => void) =>
      subscribe('terminal:data', handler)
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
    onWorkspaceChanged: (handler: (cwd: string) => void) =>
      subscribe('workspace:changed', handler)
  }
}

contextBridge.exposeInMainWorld('forge', api)

export type ForgeApi = typeof api
