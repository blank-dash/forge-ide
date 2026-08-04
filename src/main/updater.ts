import { app } from 'electron'
import { autoUpdater } from 'electron-updater'

export interface UpdateStatus {
  state: 'idle' | 'checking' | 'available' | 'downloading' | 'ready' | 'none' | 'error'
  version?: string
  notes?: string
  percent?: number
  message?: string
  /** False in development or when no publish target is configured. */
  supported: boolean
}

const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000
const FIRST_CHECK_DELAY_MS = 20_000

/**
 * Update checks against the GitHub releases feed electron-builder publishes.
 *
 * Downloads are never automatic: an IDE that swaps itself out from under an
 * in-flight agent turn would be worse than one that is a day out of date. The
 * user is told an update exists and chooses when to take it.
 */
export class Updater {
  private status: UpdateStatus
  private timer: NodeJS.Timeout | null = null
  private wired = false

  constructor(private readonly emit: (status: UpdateStatus) => void) {
    // Packaged builds only: in dev there is no app-update.yml to read.
    this.status = { state: 'idle', supported: app.isPackaged }
  }

  current(): UpdateStatus {
    return this.status
  }

  start(): void {
    if (!this.status.supported) return
    this.wire()

    setTimeout(() => void this.check(), FIRST_CHECK_DELAY_MS).unref?.()
    this.timer = setInterval(() => void this.check(), CHECK_INTERVAL_MS)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  async check(): Promise<UpdateStatus> {
    if (!this.status.supported) {
      return this.set({
        state: 'none',
        message: 'Updates are only available in an installed build.'
      })
    }

    this.wire()
    this.set({ state: 'checking' })

    try {
      const result = await autoUpdater.checkForUpdates()
      // A null result means the feed answered but had nothing newer.
      if (!result?.updateInfo) return this.set({ state: 'none' })
      return this.status
    } catch (error) {
      return this.set({ state: 'error', message: (error as Error).message })
    }
  }

  async download(): Promise<boolean> {
    if (this.status.state !== 'available') return false
    try {
      this.set({ state: 'downloading', percent: 0 })
      await autoUpdater.downloadUpdate()
      return true
    } catch (error) {
      this.set({ state: 'error', message: (error as Error).message })
      return false
    }
  }

  install(): boolean {
    if (this.status.state !== 'ready') return false
    // isSilent false so the installer UI appears; isForceRunAfter reopens us.
    setImmediate(() => autoUpdater.quitAndInstall(false, true))
    return true
  }

  private wire(): void {
    if (this.wired) return
    this.wired = true

    autoUpdater.autoDownload = false
    autoUpdater.autoInstallOnAppQuit = false

    autoUpdater.on('update-available', (info) =>
      this.set({
        state: 'available',
        version: info.version,
        notes: typeof info.releaseNotes === 'string' ? info.releaseNotes : undefined
      })
    )
    autoUpdater.on('update-not-available', () => this.set({ state: 'none' }))
    autoUpdater.on('download-progress', (progress) =>
      this.set({ state: 'downloading', percent: Math.round(progress.percent) })
    )
    autoUpdater.on('update-downloaded', (info) =>
      this.set({ state: 'ready', version: info.version })
    )
    autoUpdater.on('error', (error) =>
      this.set({ state: 'error', message: error?.message ?? String(error) })
    )
  }

  private set(patch: Partial<UpdateStatus>): UpdateStatus {
    this.status = { ...this.status, ...patch, supported: this.status.supported }
    this.emit(this.status)
    return this.status
  }
}
