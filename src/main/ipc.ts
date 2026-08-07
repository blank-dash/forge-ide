import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import type {
  AgentEvent,
  McpServerConfig,
  PendingChange,
  PermissionDecision,
  ProviderConfig,
  ScheduledTask,
  SessionRecord,
  Settings
} from '@shared/types'
import { validateTask } from '@shared/tasks'
import { applyAccountEnv, verifyGithubToken } from './account'
import { Browser, type Bounds } from './browser'
import { SessionManager } from './agent/manager'
import { SkillLibrary } from './agent/skills'
import { activeTools, makeUseSkillTool, shellInfo } from './agent/tools'
import { makeBrowserTools } from './agent/tools/browser'
import { makeLiveTools } from './agent/tools/live'
import { makeWebTools } from './agent/tools/search.web'
import { LiveSession, type LiveAccess } from './live/session'
import { Git } from './git'
import { McpManager } from './mcp/manager'
import { listModelsCached, testProvider } from './providers'
import { createNotifier } from './notify'
import { Scheduler } from './scheduler'
import { CheckpointStore } from './checkpoints'
import { SessionStore } from './sessions'
import { UsageLog } from './usage'
import { WorkspaceIndex } from './workspace-index'
import { SettingsStore } from './store'
import { shellLabel as terminalShellLabel, TerminalManager } from './terminal'
import { TaskRunner } from './task-runner'
import { TaskStore } from './tasks'
import { Updater } from './updater'
import { speakSystem, stopSystemSpeech, systemVoices } from './speech'
import { speak, transcribe, type SpeakRequest, type TranscribeRequest } from './voice'
import { Workspace } from './workspace'

export interface Services {
  settings: SettingsStore
  workspace: Workspace
  terminals: TerminalManager
  manager: SessionManager
  mcp: McpManager
  git: Git
  sessions: SessionStore
  checkpoints: CheckpointStore
  usage: UsageLog
  index: WorkspaceIndex
  updater: Updater
  skills: SkillLibrary
  browser: Browser
  live: LiveSession
  tasks: TaskStore
  scheduler: Scheduler
  /** Re-reads the task list for the current workspace and re-arms the timer. */
  reloadTasks(): Promise<void>
  /** Ids of conversations owned by a scheduled task; not writable by hand. */
  taskSessions: ReadonlySet<string>
  /** Subscribes a session's change tracker so its edits reach the UI. */
  trackChanges(sessionId: string): void
  closeChanges(sessionId: string): void
  dispose(): void
}

/** The live preview only has to be recognisable, not readable. */
const PREVIEW_WIDTH = 480

/** Git status is polled rather than watched; this is the floor between refreshes. */
const GIT_CONTEXT_TTL_MS = 4_000

export function createServices(getWindow: () => BrowserWindow | null): Services {
  const settings = new SettingsStore()
  // Anything the agent shells out to inherits this process's environment, so a
  // linked account has to be published before the first command can run.
  applyAccountEnv(settings.get())
  const workspace = new Workspace()
  const terminals = new TerminalManager(() => getWindow()?.webContents ?? null)
  const git = new Git(() => workspace.cwd)
  const sessions = new SessionStore(() => workspace.cwd)
  const checkpoints = new CheckpointStore(() => workspace.cwd)
  const index = new WorkspaceIndex(() => workspace.cwd)
  const usage = new UsageLog()
  const tasks = new TaskStore(() => workspace.cwd)
  const mcp = new McpManager()

  const pendingPermissions = new Map<string, (decision: PermissionDecision) => void>()
  const changeSubs = new Map<string, () => void>()

  const send = (channel: string, payload: unknown): void => {
    const window = getWindow()
    if (window && !window.isDestroyed()) window.webContents.send(channel, payload)
  }

  let gitCache: { at: number; value: string } | null = null
  const gitContext = async (): Promise<string> => {
    if (gitCache && Date.now() - gitCache.at < GIT_CONTEXT_TTL_MS) return gitCache.value
    const value = await git.promptContext().catch(() => '')
    gitCache = { at: Date.now(), value }
    return value
  }

  const skills = new SkillLibrary()
  const useSkill = makeUseSkillTool(
    (name) => skills.find(name, settings.get().disabledSkills),
    () => skills.all(settings.get().disabledSkills)
  ) as unknown as Parameters<typeof activeTools>[0][number]

  const browser = new Browser(getWindow, (state) => send('browser:state', state))
  const scout = new Browser(getWindow, () => undefined, { headless: true })

  const live = new LiveSession(
    (status) => send('live:status', status),
    (action) => send('live:action', action)
  )

  const sendSessions = (): void => send('sessions:changed', manager.list())

  // Built with the view rather than declared statically: they need the live
  // browser, and `reveal` brings the pane to the front so the user sees what
  // the agent just opened rather than only reading about it.
  const browserTools = makeBrowserTools(browser, () =>
    send('browser:reveal', true)
  ) as unknown as Parameters<typeof activeTools>[0]

  // Reading the web happens through a view that never joins the window, so a
  // lookup does not take over the screen or navigate the page you are on.
  const webTools = makeWebTools(scout) as unknown as Parameters<typeof activeTools>[0]

  /**
   * What the model can reach into the host with.
   *
   * The live tools are added only while a session is running, and only the ones
   * that session's access level allows. An inactive live mode is therefore not
   * a permission the model can argue about — the capability is absent.
   */
  const hostTools = (sessionId?: string): Parameters<typeof activeTools>[0] =>
    live.isActive && live.current().sessionId === sessionId
      ? ([
          ...browserTools,
          ...webTools,
          ...(makeLiveTools(live) as unknown as Parameters<typeof activeTools>[0])
        ] as Parameters<typeof activeTools>[0])
      : ([...browserTools, ...webTools] as Parameters<typeof activeTools>[0])

  const manager: SessionManager = new SessionManager(
    (currentId) => ({
      cwd: () => workspace.cwd,
      settings: () => settings.get(),
      skillTool: () => (skills.all(settings.get().disabledSkills).length > 0 ? useSkill : null),
      hostTools: () => hostTools(currentId()),
      beforeWrite: (absolutePath) => checkpoints.capture(currentId(), absolutePath),
      turnBegan: () => checkpoints.begin(currentId()),
      turnEnded: (label) => {
        const id = currentId()
        void checkpoints.commit(id, label).then((saved) => {
          // Files changed, so the quick-open list is stale.
          if (saved) index.invalidate()
          if (saved) send('checkpoints:changed', true)
        })
      },
      skillCatalogue: () => skills.catalogue(settings.get().disabledSkills),
      saveSettings: (next) => {
        settings.set(next)
        send('settings:changed', settings.get())
      },
      emit: (event) => {
        send('agent:event', { sessionId: currentId(), event })
        // The sidebar marks which conversations are working, and those are the
        // two moments that changes.
        if (event.type === 'turn_start' || event.type === 'idle') sendSessions()
      },
      askUser: (request, signal) =>
        new Promise<PermissionDecision>((resolve) => {
          const window = getWindow()
          if (!window || window.isDestroyed()) {
            resolve({ action: 'deny', reason: 'No window available.' })
            return
          }

          // Honoured here rather than inside the tool: this branch is what
          // "a person is present" means, and presence is the condition under
          // which the user's standing approval was given.
          if (request.preApproved) {
            resolve({ action: 'allow' })
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
      persist: (record) => {
        void sessions.save(record)
        sendSessions()
      },
      recordUsage: (spent) => void usage.add(spent)
    }),
    () => sendSessions()
  )

  // Each session owns its change set, so the subscription is attached per
  // session and the event carries the id it belongs to.
  const trackChanges = (id: string): void => {
    const target = manager.get(id)
    if (!target || changeSubs.has(id)) return
    changeSubs.set(
      id,
      target.changes.onChange((changes: PendingChange[]) =>
        send('agent:event', { sessionId: id, event: { type: 'changes', changes } })
      )
    )
  }
  const offMcp = mcp.onStatus((statuses) => send('mcp:status', statuses))

  const updater = new Updater((status) => send('updates:status', status))
  updater.start()

  /* ---------------- scheduled tasks ---------------- */

  const notifier = createNotifier(getWindow, (sessionId) => send('tasks:open-session', sessionId))
  /**
   * Conversations owned by a scheduled task.
   *
   * They keep the task's permission overlay for as long as they exist, so they
   * are readable but not writable: a message typed into one would run under
   * that overlay while the UI showed the app's ordinary, safer settings.
   */
  const taskSessions = new Set<string>()

  const runner = new TaskRunner({
    manager,
    settings: () => settings.get(),
    emit: (payload) => send('tasks:activity', payload),
    claim: (sessionId) => taskSessions.add(sessionId)
  })

  const scheduler = new Scheduler({
    now: () => Date.now(),
    list: () => tasks.all(),
    save: async (task) => {
      const previous = tasks.all().find((entry) => entry.id === task.id)?.lastRun?.sessionId
      await tasks.record(task)

      // Only the most recent run's transcript is kept per task. History is
      // capped at 100 conversations per workspace and pruned oldest-first, so
      // an hourly task left running would fill it within days and start
      // evicting the user's own chats. Never touch one they have open.
      // Guarded on "open anywhere", not just "on screen": every task session
      // stays in the manager, and closing one aborts it and deletes its
      // transcript out from under whoever is reading it.
      if (
        previous &&
        previous !== task.lastRun?.sessionId &&
        previous !== manager.activeId &&
        !manager.get(previous)?.isRunning
      ) {
        manager.close(previous)
        taskSessions.delete(previous)
        await sessions.remove(previous)
      }
    },
    run: (task) => runner.run(task),
    emit: (event) => {
      const task = 'taskId' in event ? tasks.all().find((e) => e.id === event.taskId) : undefined
      // Carried on the wire so the toast can name the task without a round trip
      // back to the main process for a list it already caused to change.
      send('tasks:event', { ...event, taskName: task?.name ?? '' })
      send('tasks:changed', tasks.all())

      if (event.type === 'task_finished' && task) notifier.taskFinished(task, event.result)
    },
    setTimer: (fn, ms) => {
      const handle = setTimeout(fn, ms)
      // An armed timer would otherwise hold the Node event loop open and delay
      // quit by however long the next task is away.
      handle.unref?.()
      return handle
    },
    clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)
  })

  /**
   * Points the scheduler at the current workspace.
   *
   * Called from both entry points on purpose. `createServices` runs before any
   * folder has been resolved — the workspace is still whatever directory the
   * process was launched from — so arming there and never again meant a task
   * list was read from the wrong bucket and no task ever fired.
   */
  const reloadTasks = async (): Promise<void> => {
    tasks.invalidate()
    await tasks.load()
    send('tasks:changed', tasks.all())
    scheduler.refresh()
  }

  const services: Services = {
    settings,
    workspace,
    terminals,
    manager,
    mcp,
    git,
    sessions,
    checkpoints,
    index,
    usage,
    updater,
    skills,
    browser,
    live,
    tasks,
    scheduler,
    trackChanges,
    reloadTasks,
    taskSessions,
    closeChanges(sessionId: string): void {
      changeSubs.get(sessionId)?.()
      changeSubs.delete(sessionId)
    },
    /**
     * Shutdown, subsystem by subsystem, with none able to stop the others.
     *
     * This runs from `before-quit`, so anything that throws here can leave the
     * app alive with its window gone — a process nobody can see and nobody can
     * close, which then makes the installer refuse to update over it. A stray
     * EPIPE writing to an already-dead helper is enough to cause that, so no
     * single step is trusted not to fail.
     */
    dispose(): void {
      const step = (what: string, fn: () => void): void => {
        try {
          fn()
        } catch (error) {
          console.error(`[shutdown] ${what} failed`, error)
        }
      }

      step('change subscriptions', () => {
        for (const off of changeSubs.values()) off()
        changeSubs.clear()
      })
      step('mcp status', offMcp)
      step('updater', () => updater.stop())
      step('scheduler', () => scheduler.stop())
      step('browser', () => browser.dispose())
      step('background browser', () => scout.dispose())
      step('speech', stopSystemSpeech)
      step('usage log', () => void usage.flush())
      // Never left running past the window: sharing a screen must end when the
      // thing you started it from is gone.
      step('live mode', () => live.stop())
      step('conversations', () => manager.abortAll())
      step('terminals', () => terminals.killAll())
      step('mcp servers', () => mcp.stopAll())
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
  const { settings, workspace, terminals, manager, mcp, git, sessions, updater, skills } = services
  const { tasks, scheduler, reloadTasks, browser, live, checkpoints, index, usage } = services
  const { trackChanges } = services

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
    if (last && !workspace.isExplicit)
      await workspace
        .open(last)
        .catch((error) =>
          console.warn('[workspace] could not restore recent workspace', last, error)
        )

    // Servers start in the background: a slow one must not delay the window.
    void mcp.sync(loaded.mcpServers)
    await skills.load(workspace.cwd)
    // The workspace is only settled here, so this is the first moment the
    // scheduler can be armed against the right folder.
    await reloadTasks()

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
    applyAccountEnv(saved)

    if (JSON.stringify(before.mcpServers) !== JSON.stringify(saved.mcpServers)) {
      void mcp.sync(saved.mcpServers)
    }
    return saved
  })

  /**
   * Confirms a GitHub token and returns the account it belongs to. Kept in the
   * main process so the token is never handed to a renderer fetch.
   */
  handle('account:verify-github', async (token: string) => verifyGithubToken(token))

  handle('settings:export', async () => {
    const window = getWindow()
    if (!window) throw new Error('No window.')

    const result = await dialog.showSaveDialog(window, {
      title: 'Export Forge dash settings',
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
      title: 'Import Forge dash settings',
      properties: ['openFile'],
      filters: [{ name: 'JSON', extensions: ['json'] }]
    })
    if (result.canceled || result.filePaths.length === 0) return null

    const raw = await readFile(result.filePaths[0], 'utf8')
    const parsed = JSON.parse(raw) as Settings
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.providers)) {
      throw new Error('That file does not look like a Forge dash settings export.')
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
      return await listModelsCached(provider, controller.signal)
    } finally {
      clearTimeout(timer)
    }
  })

  /* ---------------- workspace ---------------- */

  const adoptWorkspace = async (target: string): Promise<{ cwd: string; name: string }> => {
    // Everything that reads the workspace lazily has to be stopped before it
    // moves. `cwd` is resolved per call — a task mid-run would otherwise finish
    // against the new folder, and the timer armed for the old one stays live
    // across the whole switch.
    scheduler.stopUntilRefreshed()
    tasks.invalidate()
    manager.abortAll()
    terminals.killAll()

    const root = await workspace.open(target)
    const current = settings.get()
    settings.set({
      ...current,
      recentWorkspaces: [root, ...current.recentWorkspaces.filter((entry) => entry !== root)].slice(
        0,
        10
      )
    })
    invalidateGit()
    // Project skills live in the workspace, so they change with it.
    await skills.load(root)

    // Conversations belong to the folder they were had in, task-owned ones
    // included; leaving them open would carry them into the new workspace's
    // list and hold their memory for the life of the process.
    manager.closeAll()
    await reloadTasks()

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

  /** Writes text to a file the user picks. Returns the path, or null. */
  handle('fs:export', async (payload: { text: string; suggested: string }) => {
    const window = getWindow()
    if (!window) throw new Error('No window.')

    const result = await dialog.showSaveDialog(window, {
      title: 'Save',
      defaultPath: path.join(workspace.cwd, payload.suggested),
      filters: [{ name: 'Markdown', extensions: ['md'] }]
    })
    if (result.canceled || !result.filePath) return null

    await writeFile(result.filePath, payload.text, 'utf8')
    return result.filePath
  })

  /* ---------------- quick open and search ---------------- */

  handle('index:files', () => index.files())
  handle('index:refresh', async () => {
    index.invalidate()
    return index.files()
  })
  handle(
    'index:search',
    (payload: { query: string; regex?: boolean; caseSensitive?: boolean; include?: string }) =>
      index.search(payload.query, payload)
  )

  /* ---------------- usage history ---------------- */

  handle('usage:history', () => usage.read())

  /* ---------------- checkpoints ---------------- */

  handle('checkpoints:list', () => checkpoints.list())
  handle('checkpoints:restore', async (id: string) => {
    const result = await checkpoints.restore(id)
    index.invalidate()
    // Editors are holding the old text; they have to be told to re-read.
    send('files:changed', true)
    return result
  })
  handle('checkpoints:remove', async (id: string) => {
    await checkpoints.remove(id)
    return true
  })

  /* ---------------- voice ---------------- */

  // Both go through the main process rather than the renderer so the API key
  // never has to be handed to a page.
  handle('voice:transcribe', (payload: TranscribeRequest) => transcribe(settings.get(), payload))
  handle('voice:speak', (payload: SpeakRequest) => speak(settings.get(), payload))

  /**
   * The system synthesiser, driven from here rather than from the page.
   *
   * Chromium's own speech API is backed by a service Electron does not ship, so
   * in the renderer it reports no voices and speaks nothing at all — silently.
   */
  handle('voice:voices', () => systemVoices())
  handle('voice:say', async (payload: { text: string; voice: string; rate: number }) => {
    await speakSystem(payload.text, payload.voice, payload.rate)
    return true
  })
  handle('voice:hush', async () => {
    stopSystemSpeech()
    return true
  })

  /* ---------------- live mode ---------------- */

  handle('live:sources', () => live.sources())
  handle('live:status', async () => live.current())

  handle(
    'live:start',
    async (payload: { sourceId: string; access: LiveAccess; sessionId?: string }) => {
      const sessionId = payload.sessionId ?? manager.activeId
      if (!manager.get(sessionId)) throw new Error('That conversation is no longer open.')
      return live.start(payload.sourceId, payload.access, sessionId)
    }
  )
  handle('live:stop', async () => live.stop())

  /** A frame for the preview, so the user sees exactly what the agent sees. */
  handle('live:frame', async () => {
    const frame = await live.look(PREVIEW_WIDTH)
    return `data:image/png;base64,${frame.data}`
  })

  /* ---------------- built-in browser ---------------- */

  // The view is laid over the window rather than inside the DOM, so the
  // renderer has to tell it where the pane is and whether it is on screen.
  ipcMain.on('browser:layout', (_event, payload: { bounds: Bounds; visible: boolean }) => {
    browser.setBounds(payload.bounds)
    browser.setVisible(payload.visible)
  })

  handle('browser:navigate', (url: string) => browser.navigate(url))
  handle('browser:state', async () => browser.state())
  handle('browser:back', async () => {
    browser.back()
    return true
  })
  handle('browser:forward', async () => {
    browser.forward()
    return true
  })
  handle('browser:reload', async () => {
    browser.reload()
    return true
  })
  handle('browser:stop', async () => {
    browser.stop()
    return true
  })
  handle('browser:open-external', async () => {
    browser.openExternally()
    return true
  })
  handle('browser:clear', async () => {
    await browser.clearData()
    return true
  })

  /* ---------------- scheduled tasks ---------------- */

  /** Live state the list needs but the stored record does not carry. */
  const withRunning = (list: ScheduledTask[]): Array<ScheduledTask & { running: boolean }> =>
    list.map((task) => ({ ...task, running: scheduler.isRunning(task.id) }))

  handle('tasks:list', async () => withRunning(await tasks.load()))

  handle('tasks:save', async (task: Partial<ScheduledTask>) => {
    const problem = validateTask({
      prompt: task.prompt ?? '',
      schedule: task.schedule ?? { kind: 'interval', everyMinutes: 60 }
    })
    if (problem) throw new Error(problem)

    // Only the fields a person edits are taken from the caller. The editor
    // holds a snapshot from when it opened, so trusting it wholesale would let
    // a form left open across a run write that run's record back out of
    // existence — and reset the schedule with it.
    const existing = (await tasks.load()).find((entry) => entry.id === task.id)
    const saved = await tasks.upsert({
      ...existing,
      id: task.id,
      name: task.name,
      prompt: task.prompt,
      schedule: task.schedule,
      enabled: task.enabled,
      permission: task.permission,
      model: task.model,
      notify: task.notify
    })
    send('tasks:changed', tasks.all())
    // Editing a schedule takes effect now, not after the old one fires once more.
    scheduler.refresh()
    return saved
  })

  handle('tasks:remove', async (id: string) => {
    await tasks.remove(id)
    send('tasks:changed', tasks.all())
    scheduler.refresh()
    return true
  })

  /** Runs a task immediately, ignoring its schedule. */
  handle('tasks:run', async (id: string) => {
    const result = await scheduler.runNow(id)
    send('tasks:changed', tasks.all())
    return result
  })

  handle('fs:pick', async (kind: 'files' | 'folder') => {
    const window = getWindow()
    if (!window) throw new Error('No window.')

    const result = await dialog.showOpenDialog(window, {
      title: kind === 'folder' ? 'Attach a folder' : 'Attach files',
      defaultPath: workspace.cwd,
      properties: kind === 'folder' ? ['openDirectory'] : ['openFile', 'multiSelections']
    })
    return result.canceled ? [] : result.filePaths
  })

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
    (payload: {
      text: string
      images?: Array<{ mediaType: string; data: string }>
      sessionId?: string
    }) => {
      // Deliberately not awaited: the turn streams events until it finishes and
      // the renderer must not block on it. Failures still have to surface,
      // otherwise the UI sits on a spinner forever.
      const target = payload.sessionId ? manager.get(payload.sessionId) : manager.current()
      if (!target) throw new Error('That conversation is no longer open.')

      // A task conversation keeps that task's permission overlay for as long as
      // it exists — at "full" that is every command auto-approved with nothing
      // shown. Typing into it would run under those powers while the settings
      // bar reported the app's ordinary, safer state.
      if (services.taskSessions.has(target.id)) {
        throw new Error(
          'This conversation is the record of a scheduled task run. It cannot be ' +
            'continued by hand — start a new chat instead.'
        )
      }

      trackChanges(target.id)
      target.send(payload.text, payload.images ?? []).catch((error: Error) => {
        const fail = (event: AgentEvent): void =>
          send('agent:event', { sessionId: target.id, event })
        fail({ type: 'error', message: error.message })
        fail({ type: 'idle' })
      })
      return target.id
    }
  )

  handle('agent:abort', (sessionId?: string) => {
    ;(sessionId ? manager.get(sessionId) : manager.current())?.abort()
    return true
  })

  /** Opens a fresh conversation; the previous one keeps running untouched. */
  handle('agent:new', () => {
    const created = manager.create()
    trackChanges(created.id)
    return created.id
  })

  handle('agent:activate', (sessionId: string) => manager.activate(sessionId))

  handle('agent:model', (payload: { model: string; sessionId?: string }) => {
    const target = payload.sessionId ? manager.get(payload.sessionId) : manager.current()
    if (!target) throw new Error('That conversation is no longer open.')
    target.model = payload.model
    return payload.model
  })

  handle('agent:close', (sessionId: string) => {
    manager.close(sessionId)
    services.closeChanges(sessionId)
    return true
  })

  handle('agent:state', (sessionId?: string) => {
    const target = sessionId ? manager.get(sessionId) : manager.current()
    if (!target) return null
    trackChanges(target.id)
    return {
      id: target.id,
      title: target.title,
      messages: target.messages,
      totals: target.totals,
      running: target.isRunning,
      changes: target.changes.list()
    }
  })

  handle('agent:live', () => manager.list())

  ipcMain.removeAllListeners('permission:respond')
  ipcMain.on(
    'permission:respond',
    (_event, payload: { id: string; decision: PermissionDecision }) => {
      // `settle` removes itself from the map and detaches its abort listener.
      pendingPermissions.get(payload?.id)?.(payload.decision)
    }
  )

  /* ---------------- pending changes ---------------- */

  const changesOf = (sessionId?: string) =>
    (sessionId ? manager.get(sessionId) : manager.current())?.changes

  handle('changes:list', (sessionId?: string) => changesOf(sessionId)?.list() ?? [])
  handle('changes:accept', (id: string, sessionId?: string) => {
    changesOf(sessionId)?.accept(id)
    return true
  })
  handle('changes:acceptAll', (sessionId?: string) => {
    changesOf(sessionId)?.acceptAll()
    return true
  })
  handle('changes:reject', async (id: string, sessionId?: string) => {
    await changesOf(sessionId)?.reject(id)
    invalidateGit()
    return true
  })
  handle('changes:rejectAll', async (sessionId?: string) => {
    await changesOf(sessionId)?.rejectAll()
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

  handle('sessions:list', async () => manager.mergeSummaries(await sessions.list()))
  handle('sessions:load', async (id: string) => {
    const record = await sessions.load(id)
    if (!record) throw new Error('That session could not be read.')
    const opened = manager.adopt(record)
    trackChanges(opened.id)
    return record satisfies SessionRecord
  })
  handle('sessions:remove', async (id: string) => {
    await sessions.remove(id)
    return true
  })

  /* ---------------- skills ---------------- */

  handle('skills:list', () => skills.all([]))
  handle('skills:reload', async () => {
    await skills.load(workspace.cwd)
    return skills.all([])
  })
  handle('skills:open-folder', async (scope: 'global' | 'project') => {
    const dir = await skills.createDir(workspace.cwd, scope)
    await shell.openPath(dir)
    return dir
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
