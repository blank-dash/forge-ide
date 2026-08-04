import { promises as fs, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { app, screen, type BrowserWindow } from 'electron'

export interface WindowState {
  x?: number
  y?: number
  width: number
  height: number
  maximized: boolean
}

const DEFAULTS: WindowState = { width: 1560, height: 980, maximized: false }

function file(): string {
  return path.join(app.getPath('userData'), 'window-state.json')
}

/**
 * Restores the window where the user left it, discarding positions that no
 * longer land on a connected display — otherwise unplugging a second monitor
 * leaves the app opening off-screen with no way back.
 */
export function loadWindowState(): WindowState {
  let saved: Partial<WindowState>
  try {
    saved = JSON.parse(readFileSync(file(), 'utf8')) as Partial<WindowState>
  } catch {
    return DEFAULTS
  }

  const state: WindowState = {
    width: clamp(saved.width ?? DEFAULTS.width, 900, 10_000),
    height: clamp(saved.height ?? DEFAULTS.height, 600, 10_000),
    maximized: saved.maximized === true,
    x: saved.x,
    y: saved.y
  }

  if (state.x === undefined || state.y === undefined) return state

  const visible = screen.getAllDisplays().some((display) => {
    const { x, y, width, height } = display.workArea
    return (
      state.x! + state.width > x &&
      state.x! < x + width &&
      state.y! + state.height > y &&
      state.y! < y + height
    )
  })

  if (!visible) {
    delete state.x
    delete state.y
  }
  return state
}

/** Persists on move/resize, debounced so dragging does not hammer the disk. */
export function trackWindowState(window: BrowserWindow): () => void {
  let timer: NodeJS.Timeout | null = null

  const save = (): void => {
    if (window.isDestroyed()) return
    const bounds = window.isMaximized() ? window.getNormalBounds() : window.getBounds()
    const state: WindowState = {
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
      maximized: window.isMaximized()
    }
    try {
      writeFileSync(file(), JSON.stringify(state), 'utf8')
    } catch {
      // A window position is not worth surfacing an error for.
    }
  }

  const schedule = (): void => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(save, 400)
  }

  window.on('resize', schedule)
  window.on('move', schedule)
  window.on('maximize', schedule)
  window.on('unmaximize', schedule)
  window.on('close', save)

  return () => {
    if (timer) clearTimeout(timer)
    window.removeListener('resize', schedule)
    window.removeListener('move', schedule)
    window.removeListener('maximize', schedule)
    window.removeListener('unmaximize', schedule)
    window.removeListener('close', save)
  }
}

/** First existing directory among the CLI arguments, for "Open with Forge". */
export async function folderFromArgv(argv: string[]): Promise<string | null> {
  for (const arg of argv.slice(1)) {
    if (arg.startsWith('-') || arg.endsWith('.js') || arg.endsWith('.asar')) continue
    const stat = await fs.stat(arg).catch(() => null)
    if (stat?.isDirectory()) return path.resolve(arg)
  }
  return null
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}
