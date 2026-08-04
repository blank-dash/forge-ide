import { readFile, writeFile } from 'node:fs/promises'
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import type {
  AgentEvent,
  McpServerConfig,
  PendingChange,
  PermissionDecision,
  ProviderConfig,
  SessionRecord,
  Settings
} from '@shared/types'
import { AgentSession } from './agent/session'
import { shellInfo } from './agent/tools'
import { Git } from './git'
import { McpManager } from './mcp/manager'
import { getAdapter, testProvider } from './providers'
import { SessionStore } from './sessions'
import { SettingsStore } from './store'
import { shellLabel as terminalShellLabel, TerminalManager } from './terminal'
import { Updater } from './updater'
import { Workspace } from './workspace'

export interface Services {
  settings: SettingsStore
  workspace: Workspace
  terminals: TerminalManager
  session: AgentSession
  mcp: McpManager
  git: Git
  sessions: SessionStore
  updater: Updater
  dispose(): void
}

/** Git status is polled rather than watched; this is the floor between refreshes. */
const GIT_CONTEXT_TTL_MS = 4_000

export function createServices(getWindow: () => BrowserWindow | null): Services {
  const settings = new SettingsStore()
  const workspace = new Workspace()
  const terminals = new TerminalManager(() => getWindow()?.webContents ?? null)
  const git = new Git(() => workspace.cwd)
  const sessions = new SessionStore(() => workspace.cwd)
  const mcp = new McpManager()

  const pendingPermissions = new Map<string, (decision: PermissionDecision) => void>()

  const send = (channel: string, payload: unknown): void => {
    const window = getWindow()
    if (window && !window.isDestroyed()) window.webContents.send(channel, payload)
  }
  const emit = (event: AgentEvent): void => send('agent:event', event)

  let gitCache: { at: number; value: string } | null = null
  const gitContext = async (): Promise<string> => {
    if (gitCache && Date.now() - gitCache.at < GIT_CONTEXT_TTL_MS) return gitCache.value
    const value = await git.promptContext().catch(() => '')
    gitCache = { at: Date.now(), value }
    return value
  }

  const session = new AgentSession({
    cwd: () => workspace.cwd,
    settings: () => settings.get(),
    saveSettings: (next) => {
      settings.set(next)
      send('settings:changed', settings.get())
    },
    emit,
    askUser: (request, signal) =>
      new Promise<PermissionDecision>((resolve) => {
        const window = getWindow()
        if (!window || window.isDestroyed()) {
          resolve({ action: 'deny', reason: 'No window available.' })
          return
        }

        const settle = (decision: PermissionDecision): void => {
          if (!pendingPermissions.has(request.id)) return
          pendingPermissions.delete(request.id)
          signal.removeEventListener('abort', onAbort)
          resolve(decision)
        }

        // Without this, stopping a turn while the dialog is open leaves the
        // tool awaiting an answer that can never come — the loop never reaches
        // its `finally`, and the session stays "running" until a restart.
        const onAbort = (): void => {
          send('permission:cancel', request.id)
          settle({ action: 'deny', reason: 'Interrupted by the user.' })
        }

        pendingPermissions.set(request.id, settle)
        signal.addEventListener('abort', onAbort, { once: true })
        window.webContents.send('permission:request', request)
      }),
    mcpTools: () => mcp.tools(),
    gitContext,
    persist: (record) => void sessions.save(record)
  })

  const offChanges = session.changes.onChange((changes: PendingChange[]) => {
    emit({ type: 'changes', changes })
  })
  const offMcp = mcp.onStatus((statuses) => send('mcp:status', statuses))

  const updater = new Updater((status) => send('updates:status', status))
  updater.start()

  const services: Services = {
    settings,
    workspace,
    terminals,
    session,
    mcp,
    git,
    sessions,
    updater,
    dispose(): void {
      offChanges()
      offMcp()
      updater.stop()
      session.abort()
      terminals.killAll()
      mcp.stopAll()
    }
  }

  registerHandlers(services, getWindow, pendingPermissions, send, () => {
    gitCache = null
  })

  return services
}

function registerHandlers(
  services: Services,
  getWindow: () => BrowserWindow | null,
  pendingPermissions: Map<string, (decision: PermissionDecision) => void>,
  send: (channel: string, payload: unknown) => void,
  invalidateGit: () => void
): void {
  const { settings, workspace, terminals, session, mcp, git, sessions, updater } = services

  const handle = <T>(channel: string, fn: (...args: never[]) => Promise<T> | T): void => {
    ipcMain.removeHandler(channel)
    ipcMain.handle(channel, async (_event, ...args) => {
      try {
        return { ok: true, value: await fn(...(args as never[])) }
      } catch (error) {
        const err = error as Error & { detail?: string }
        return { ok: false, error: err?.message ?? String(error), detail: err?.detail }
      }
    })
  }

  /* ---------------- app ---------------- */

  handle('app:bootstrap', async () => {
    const loaded = settings.load()
    // A folder passed on the command line wins over the last-used one.
    const last = loaded.recentWorkspaces[0]
    if (last && !workspace.isExplicit) await workspace.open(last).catch(() => undefined)

    // Servers start in the background: a slow one must not delay the window.
    void mcp.sync(loaded.mcpServers)

    return {
      settings: loaded,
      cwd: workspace.cwd,
      workspaceName: workspace.name,
      keysEncrypted: settings.keysEncrypted,
      settingsPath: settings.file,
      platform: process.platform,
      // The agent's run_command shell and the terminal's shell are chosen
      // independently and often differ, so reporting one as "the" shell misleads.
      shellLabel: shellInfo().label,
      terminalShell: terminalShellLabel(),
      gitAvailable: await git.isAvailable(),
      appVersion: app.getVersion(),
      updates: updater.current()
    }
  })

  handle('app:open-external', async (url: string) => {
    if (!/^https?:\/\//i.test(url)) throw new Error('Only http(s) links can be opened.')
    await shell.openExternal(url)
    return true
  })

  /* ---------------- settings ---------------- */

  handle('settings:get', () => settings.get())

  handle('settings:set', async (next: Settings) => {
    const before = settings.get()
    const saved = settings.set(next)
    send('settings:changed', saved)

    if (JSON.stringify(before.mcpServers) !== JSON.stringify(saved.mcpServers)) {
      void mcp.sync(saved.mcpServers)
    }
    return saved
  })

  handle('settings:export', async () => {
    const window = getWindow()
    if (!window) throw new Error('No window.')

    const result = await dialog.showSaveDialog(window, {
      title: 'Export Forge settings',
      defaultPath: `forge-settings-${new Date().toISOString().slice(0, 10)}.json`,
      filters: [{ name: 'JSON', extensions: ['json'] }]
    })
    if (result.canceled || !result.filePath) return null

    // API keys stay encrypted in the export, so it is only usable on a machine
    // whose keychain can decrypt them — deliberately not a plain-text dump.
    await writeFile(result.filePath, settings.serialize(), 'utf8')
    return result.filePath
  })

  handle('settings:import', async () => {
    const window = getWindow()
    if (!window) throw new Error('No window.')

    const result = await dialog.showOpenDialog(window, {
      title: 'Import Forge settings',
      properties: ['openFile'],
      filters: [{ name: 'JSON', extensions: ['json'] }]
    })
    if (result.canceled || result.filePaths.length === 0) return null

    const raw = await readFile(result.filePaths[0], 'utf8')
    const parsed = JSON.parse(raw) as Settings
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.providers)) {
      throw new Error('That file does not look like a Forge settings export.')
    }

    const saved = settings.set(parsed)
    send('settings:changed', saved)
    void mcp.sync(saved.mcpServers)
    return saved
  })

  handle('provider:test', (provider: ProviderConfig) => testProvider(provider))

  handle('provider:models', async (provider: ProviderConfig) => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 20_000)
    try {
      return await getAdapter(provider.kind).listModels(provider, controller.signal)
    } finally {
      clearTimeout(timer)
    }
  })

  /* ---------------- workspace ---------------- */

  const adoptWorkspace = async (target: string): Promise<{ cwd: string; name: string }> => {
    const root = await workspace.open(target)
    const current = settings.get()
    settings.set({
      ...current,
      recentWorkspaces: [root, ...current.recentWorkspaces.filter((entry) => entry !== root)].slice(0, 10)
    })
    session.reset()
    invalidateGit()
    return { cwd: root, name: workspace.name }
  }

  handle('workspace:pick', async () => {
    const window = getWindow()
    if (!window) throw new Error('No window.')
    const result = await dialog.showOpenDialog(window, {
      properties: ['openDirectory'],
      title: 'Open folder'
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return adoptWorkspace(result.filePaths[0])
  })

  handle('workspace:open', (target: string) => adoptWorkspace(target))

  handle('fs:list', (relative: string) => workspace.list(relative || '.'))
  handle('fs:read', (relative: string) => workspace.readFile(relative))
  handle('fs:write', async (relative: string, content: string) => {
    await workspace.writeFile(relative, content)
    invalidateGit()
    return true
  })

  /* ---------------- agent ---------------- */

  handle(
    'agent:send',
    (payload: { text: string; images?: Array<{ mediaType: string; data: string }> }) => {
      // Deliberately not awaited: the turn streams events until it finishes and
      // the renderer must not block on it. Failures still have to surface,
      // otherwise the UI sits on a spinner forever.
      session.send(payload.text, payload.images ?? []).catch((error: Error) => {
        send('agent:event', { type: 'error', message: error.message } satisfies AgentEvent)
        send('agent:event', { type: 'idle' } satisfies AgentEvent)
      })
      return true
    }
  )

  handle('agent:abort', () => {
    session.abort()
    return true
  })

  handle('agent:reset', () => {
    session.reset()
    return true
  })

  handle('agent:state', () => ({
    id: session.id,
    title: session.title,
    messages: session.messages,
    totals: session.totals,
    running: session.isRunning,
    changes: session.changes.list()
  }))

  ipcMain.removeAllListeners('permission:respond')
  ipcMain.on('permission:respond', (_event, payload: { id: string; decision: PermissionDecision }) => {
    // `settle` removes itself from the map and detaches its abort listener.
    pendingPermissions.get(payload?.id)?.(payload.decision)
  })

  /* ---------------- pending changes ---------------- */

  handle('changes:list', () => session.changes.list())
  handle('changes:accept', (id: string) => {
    session.changes.accept(id)
    return true
  })
  handle('changes:acceptAll', () => {
    session.changes.acceptAll()
    return true
  })
  handle('changes:reject', async (id: string) => {
    await session.changes.reject(id)
    invalidateGit()
    return true
  })
  handle('changes:rejectAll', async () => {
    await session.changes.rejectAll()
    invalidateGit()
    return true
  })

  /* ---------------- git ---------------- */

  handle('git:status', () => git.status())
  handle('git:diff', (file: string, staged: boolean) => git.diff(file, staged))
  handle('git:stage', async (paths: string[]) => {
    await git.stage(paths)
    invalidateGit()
    return true
  })
  handle('git:unstage', async (paths: string[]) => {
    await git.unstage(paths)
    invalidateGit()
    return true
  })
  handle('git:discard', async (paths: string[]) => {
    await git.discard(paths)
    invalidateGit()
    return true
  })
  handle('git:commit', async (message: string, stageAll: boolean) => {
    const result = await git.commit(message, stageAll)
    invalidateGit()
    return result
  })
  handle('git:log', (limit: number) => git.log(limit))
  handle('git:branches', () => git.branches())
  handle('git:checkout', async (branch: string) => {
    await git.checkout(branch)
    invalidateGit()
    return true
  })

  /* ---------------- mcp ---------------- */

  handle('mcp:status', () => mcp.statuses())
  handle('mcp:restart', async (id: string) => {
    await mcp.restart(id, settings.get().mcpServers)
    return mcp.statuses()
  })
  handle('mcp:sync', async (servers: McpServerConfig[]) => {
    await mcp.sync(servers)
    return mcp.statuses()
  })

  /* ---------------- sessions ---------------- */

  handle('sessions:list', () => sessions.list())
  handle('sessions:load', async (id: string) => {
    const record = await sessions.load(id)
    if (!record) throw new Error('That session could not be read.')
    session.restore(record)
    return record satisfies SessionRecord
  })
  handle('sessions:remove', async (id: string) => {
    await sessions.remove(id)
    return true
  })

  /* ---------------- updates ---------------- */

  handle('updates:check', () => updater.check())
  handle('updates:download', () => updater.download())
  handle('updates:install', () => updater.install())

  /* ---------------- terminal ---------------- */

  handle('terminal:create', (size: { cols: number; rows: number }) =>
    terminals.create(workspace.cwd, size?.cols, size?.rows)
  )

  ipcMain.removeAllListeners('terminal:write')
  ipcMain.on('terminal:write', (_event, payload: { id: string; data: string }) => {
    terminals.write(payload.id, payload.data)
  })

  ipcMain.removeAllListeners('terminal:resize')
  ipcMain.on('terminal:resize', (_event, payload: { id: string; cols: number; rows: number }) => {
    terminals.resize(payload.id, payload.cols, payload.rows)
  })

  handle('terminal:kill', (id: string) => {
    terminals.kill(id)
    return true
  })
}
