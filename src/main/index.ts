import { join } from 'node:path'
import { app, BrowserWindow, shell } from 'electron'
import { createServices, type Services } from './ipc'
import { buildMenu } from './menu'
import { folderFromArgv, loadWindowState, trackWindowState } from './window-state'

let mainWindow: BrowserWindow | null = null
let services: Services | null = null
let untrackWindow: (() => void) | null = null

const getWindow = (): BrowserWindow | null =>
  mainWindow && !mainWindow.isDestroyed() ? mainWindow : null

/**
 * A crash in an async corner of the main process would otherwise take the whole
 * app down silently. Surface it in the UI and keep running — every long-lived
 * subsystem here (MCP servers, shells, provider streams) can fail
 * independently without the editor needing to die.
 */
function installCrashGuards(): void {
  const report = (label: string, error: unknown): void => {
    const message = error instanceof Error ? error.message : String(error)
    const detail = error instanceof Error ? error.stack : undefined
    console.error(`[${label}]`, error)
    getWindow()?.webContents.send('agent:event', {
      type: 'error',
      message: `${label}: ${message}`,
      detail
    })
  }

  process.on('uncaughtException', (error) => report('Unexpected error', error))
  process.on('unhandledRejection', (reason) => report('Unhandled rejection', reason))
}

function createWindow(): void {
  const state = loadWindowState()

  mainWindow = new BrowserWindow({
    x: state.x,
    y: state.y,
    width: state.width,
    height: state.height,
    minWidth: 900,
    minHeight: 600,
    show: false,
    backgroundColor: '#141413',
    autoHideMenuBar: true,
    titleBarStyle: 'hidden',
    titleBarOverlay:
      process.platform === 'win32'
        ? { color: '#141413', symbolColor: '#8a8780', height: 36 }
        : undefined,
    trafficLightPosition: { x: 14, y: 11 },
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false
    }
  })

  if (state.maximized) mainWindow.maximize()
  untrackWindow = trackWindowState(mainWindow)

  mainWindow.on('ready-to-show', () => mainWindow?.show())

  // Anything the app tries to open in a new window goes to the real browser.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })

  // Block in-page navigation away from the app shell.
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const devUrl = process.env['ELECTRON_RENDERER_URL']
    if (devUrl && url.startsWith(devUrl)) return
    event.preventDefault()
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
  })

  // Renderer warnings and errors are invisible without devtools open; mirror
  // them to the terminal so a packaged run can still be diagnosed.
  mainWindow.webContents.on('console-message', (_event, level, message, line, source) => {
    if (level < 2) return
    const where = source ? ` (${source.split('/').pop()}:${line})` : ''
    console[level >= 3 ? 'error' : 'warn'](`[renderer]${where} ${message}`)
  })

  mainWindow.webContents.on('did-finish-load', () => console.log('[renderer] loaded'))

  // A reload throws away every terminal component without unmounting it, so
  // the shells behind them would pile up as orphaned processes.
  mainWindow.webContents.on('did-start-navigation', (event) => {
    if (event.isSameDocument) return
    services?.terminals.killAll()
  })

  // A renderer crash is recoverable — reload instead of leaving a blank window.
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    console.error('[renderer gone]', details.reason)
    if (details.reason !== 'clean-exit' && !mainWindow?.isDestroyed()) mainWindow?.reload()
  })

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) void mainWindow.loadURL(devUrl)
  else void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))

  mainWindow.on('closed', () => {
    untrackWindow?.()
    untrackWindow = null
    mainWindow = null
  })
}

/** Opens a folder passed on the command line ("Open with Forge" in Explorer). */
async function adoptArgvFolder(argv: string[]): Promise<void> {
  const folder = await folderFromArgv(argv)
  if (!folder || !services) return
  await services.workspace.open(folder).catch(() => undefined)
  getWindow()?.webContents.send('workspace:changed', folder)
}

/*
 * Windows ties a toast notification to an Application User Model ID. Without
 * this call the OS cannot match a notification to the app that raised it, and
 * scheduled-task notifications either never appear or appear unattributed.
 * It must match electron-builder's `build.appId`, which is what the installed
 * Start Menu shortcut carries.
 */
app.setAppUserModelId('dev.forge.ide')

// A build run from source gets its own profile. Without this it fights the
// installed app for the single-instance lock — the source build just exits,
// silently and confusingly — and the two would share one settings file.
if (!app.isPackaged) {
  app.setPath('userData', `${app.getPath('userData')}-dev`)
}

// A second instance would fight over the settings file and MCP child processes.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', (_event, argv) => {
    const window = getWindow()
    if (!window) return
    if (window.isMinimized()) window.restore()
    window.focus()
    void adoptArgvFolder(argv)
  })

  app.whenReady().then(async () => {
    installCrashGuards()
    services = createServices(getWindow)
    buildMenu(getWindow)

    // Must happen before the renderer bootstraps, so it sees the right folder.
    const folder = await folderFromArgv(process.argv)
    if (folder) await services.workspace.open(folder).catch(() => undefined)

    createWindow()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })

  app.on('before-quit', () => {
    services?.dispose()
    services = null
  })
}
