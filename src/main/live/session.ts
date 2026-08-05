import { captureFrame, listSources, toScreenPoint, type CaptureSource, type Frame } from './capture'
import { createInputBackend, type InputBackend, type MouseButton } from './input'

/**
 * Live mode: the agent looks at a screen and, if allowed, drives it.
 *
 * This is the most dangerous thing in the app, so the shape is deliberately
 * narrow. Nothing here starts on its own. A session names one surface and one
 * level of access, both chosen by a person, and it ends the moment they say so
 * or the app quits. There is no persisted setting that leaves it on.
 */

export type LiveAccess = 'watch' | 'control'

export interface LiveStatus {
  active: boolean
  /** Which screen or window is being shared. */
  sourceId: string
  sourceName: string
  /** Conversation that owns this screen-sharing session. */
  sessionId: string
  access: LiveAccess
  /** Set when control was asked for but the platform cannot provide it. */
  controlUnavailable?: string
  /** Actions taken since the session began, for the indicator. */
  actions: number
  startedAt: number
}

export interface LiveAction {
  kind: 'move' | 'click' | 'type' | 'key' | 'scroll' | 'drag'
  detail: string
  at: number
}

const IDLE: LiveStatus = {
  active: false,
  sourceId: '',
  sourceName: '',
  sessionId: '',
  access: 'watch',
  actions: 0,
  startedAt: 0
}

export class LiveSession {
  private status: LiveStatus = IDLE
  private input: InputBackend | null = null
  /** The last frame handed to the agent, which its coordinates refer to. */
  private lastFrame: Frame | null = null

  constructor(
    private readonly onStatus: (status: LiveStatus) => void,
    private readonly onAction: (action: LiveAction) => void
  ) {}

  sources(): Promise<CaptureSource[]> {
    return listSources()
  }

  get isActive(): boolean {
    return this.status.active
  }

  get canControl(): boolean {
    return this.status.active && this.status.access === 'control'
  }

  current(): LiveStatus {
    return this.status
  }

  async start(sourceId: string, access: LiveAccess, sessionId = ''): Promise<LiveStatus> {
    const available = await listSources()
    const source = available.find((entry) => entry.id === sourceId)
    if (!source) throw new Error('That screen or window is no longer available.')

    // Fails now rather than at the first click: starting a "control" session
    // that silently cannot control anything is worse than refusing it.
    let controlUnavailable: string | undefined
    if (access === 'control') {
      this.input = createInputBackend()
      if (!this.input.available) controlUnavailable = this.input.reason
    }

    this.status = {
      active: true,
      sourceId,
      sourceName: source.name,
      sessionId,
      access,
      controlUnavailable,
      actions: 0,
      startedAt: Date.now()
    }
    this.publish()
    return this.status
  }

  /**
   * Ends the session and releases everything.
   *
   * Called from the stop button, from quit, and from anywhere that loses
   * confidence — it must be safe to call at any time, including twice.
   */
  stop(): LiveStatus {
    this.input?.dispose()
    this.input = null
    this.lastFrame = null
    this.status = IDLE
    this.publish()
    return this.status
  }

  /**
   * A frame of the shared surface, and the coordinate space it defines.
   *
   * `width` is for the preview, which refreshes on a timer and only has to be
   * recognisable — capturing it at the size the model reads would double the
   * work for no one's benefit.
   */
  async look(width?: number): Promise<Frame> {
    this.assertActive()
    const frame = await captureFrame(this.status.sourceId, width)
    // Only a full-size frame defines the coordinate space: remembering a
    // preview-sized one would silently halve every click coordinate.
    if (width === undefined) this.lastFrame = frame
    return frame
  }

  /*
   * Access is resolved before coordinates in every action below.
   *
   * The other order looks equivalent and is not: a watch-only session would
   * answer "look at the screen first", the model would dutifully take a
   * screenshot, try again, and be refused again — never learning that control
   * was the thing it did not have.
   */

  async move(x: number, y: number): Promise<string> {
    const backend = this.backend()
    const point = this.point(x, y)
    await backend.move(point.x, point.y)
    return this.record('move', `to ${x},${y}`)
  }

  async click(x: number, y: number, button: MouseButton, double: boolean): Promise<string> {
    const backend = this.backend()
    const point = this.point(x, y)
    await backend.click(point.x, point.y, button, double)
    return this.record('click', `${double ? 'double ' : ''}${button} at ${x},${y}`)
  }

  async drag(fromX: number, fromY: number, toX: number, toY: number): Promise<string> {
    const backend = this.backend()
    const from = this.point(fromX, fromY)
    const to = this.point(toX, toY)
    await backend.drag(from.x, from.y, to.x, to.y)
    return this.record('drag', `${fromX},${fromY} to ${toX},${toY}`)
  }

  async scroll(x: number, y: number, notches: number): Promise<string> {
    const backend = this.backend()
    const point = this.point(x, y)
    // One notch is 120 units, the value Windows uses for a detent.
    await backend.scroll(point.x, point.y, Math.round(notches) * 120)
    return this.record('scroll', `${notches > 0 ? 'up' : 'down'} ${Math.abs(notches)} at ${x},${y}`)
  }

  async typeText(text: string): Promise<string> {
    const backend = this.backend()
    if (!text) throw new Error('Nothing to type.')
    await backend.typeText(text)
    return this.record('type', text.length > 40 ? `${text.slice(0, 40)}…` : text)
  }

  async pressKey(key: string, modifiers: string[]): Promise<string> {
    const backend = this.backend()
    await backend.pressKey(key, modifiers)
    return this.record('key', [...modifiers, key].join('+'))
  }

  /* ---------------------------------------------------------------- */

  private assertActive(): void {
    if (!this.status.active) {
      throw new Error('Live mode is not running. Ask the user to start it from the Live pane.')
    }
  }

  private backend(): InputBackend {
    this.assertActive()

    if (this.status.access !== 'control') {
      throw new Error(
        'This live session is watch-only. The user chose to share the screen without granting ' +
          'control, so nothing can be clicked or typed.'
      )
    }
    if (!this.input) throw new Error('The input helper is not running.')
    if (this.status.controlUnavailable) throw new Error(this.status.controlUnavailable)
    return this.input
  }

  /**
   * Maps a point on the frame the agent last saw onto the desktop.
   *
   * Requiring a prior `look` is not bookkeeping: without a frame there is no
   * scale factor and no origin, so a coordinate would land at an arbitrary
   * place on an arbitrary monitor.
   */
  private point(x: number, y: number): { x: number; y: number } {
    if (!this.lastFrame) {
      throw new Error('Look at the screen first — coordinates are relative to what you last saw.')
    }
    if (x < 0 || y < 0 || x > this.lastFrame.width || y > this.lastFrame.height) {
      throw new Error(
        `${x},${y} is outside the frame you were shown, which is ` +
          `${this.lastFrame.width}x${this.lastFrame.height}.`
      )
    }
    return toScreenPoint(this.lastFrame, x, y)
  }

  private record(kind: LiveAction['kind'], detail: string): string {
    this.status = { ...this.status, actions: this.status.actions + 1 }
    this.onAction({ kind, detail, at: Date.now() })
    this.publish()
    return `${kind}: ${detail}`
  }

  private publish(): void {
    this.onStatus(this.status)
  }
}
