import { desktopCapturer, screen } from 'electron'

/**
 * Screen capture for live mode.
 *
 * Stills, not video. The agent looks at a frame, decides, acts, and looks
 * again — a stream would cost far more and tell it nothing extra, because it
 * cannot react faster than one round trip anyway.
 */

export interface CaptureSource {
  id: string
  name: string
  kind: 'screen' | 'window'
  /** Preview for the picker, as a data URI. Small on purpose. */
  thumbnail: string
}

export interface Frame {
  /** PNG, base64, no data-URI prefix — that is what the model wants. */
  data: string
  /** Size of the image the agent is looking at. */
  width: number
  height: number
  /** Size of the real surface, in screen coordinates. */
  sourceWidth: number
  sourceHeight: number
  /** Where the surface sits, so image coordinates can be mapped to the desktop. */
  originX: number
  originY: number
}

/**
 * How wide a frame is sent to the model.
 *
 * A 4K screenshot costs several times more to look at and is no easier to
 * read — the model's vision is resolution-limited well below that. Coordinates
 * are mapped back on the way out, so the agent can click what it can see.
 */
const AGENT_WIDTH = 1280
const THUMBNAIL_WIDTH = 320

/** Everything that can be captured, for the picker. */
export async function listSources(): Promise<CaptureSource[]> {
  const sources = await desktopCapturer.getSources({
    types: ['screen', 'window'],
    thumbnailSize: { width: THUMBNAIL_WIDTH, height: Math.round(THUMBNAIL_WIDTH * 0.7) },
    fetchWindowIcons: false
  })

  return (
    sources
      // A window with no title is usually an invisible helper, not something
      // anyone means to share.
      .filter((source) => source.name.trim().length > 0)
      .map((source) => ({
        id: source.id,
        name: source.name,
        kind: source.id.startsWith('screen:') ? ('screen' as const) : ('window' as const),
        thumbnail: source.thumbnail.isEmpty() ? '' : source.thumbnail.toDataURL()
      }))
  )
}

/**
 * One frame of the chosen source.
 *
 * Two things here are latency, not tidiness.
 *
 * Only the needed type is requested: asking for screens *and* windows makes the
 * system capture every window as well, and on a busy desktop that is dozens of
 * captures to produce one frame.
 *
 * And the size is asked for directly rather than captured full and resized
 * afterwards. The scaling happens in native code during the capture instead of
 * over a 4K buffer in JavaScript, which is most of the cost.
 */
export async function captureFrame(sourceId: string, width = AGENT_WIDTH): Promise<Frame> {
  const bounds = surfaceBounds(sourceId)
  const isScreen = sourceId.startsWith('screen:')

  // Never upscale: a small window asked for at 1280 wide comes back blurry and
  // costs more to look at than the sharp original.
  const target = Math.min(width, bounds.width)
  const scaled = {
    width: target,
    height: Math.max(1, Math.round((bounds.height / bounds.width) * target))
  }

  const sources = await desktopCapturer.getSources({
    types: [isScreen ? 'screen' : 'window'],
    thumbnailSize: scaled,
    fetchWindowIcons: false
  })

  const source = sources.find((entry) => entry.id === sourceId)
  if (!source) {
    throw new Error('That screen or window is no longer available — it may have been closed.')
  }
  if (source.thumbnail.isEmpty()) {
    throw new Error(
      'The capture came back empty. On macOS this means screen recording permission has not ' +
        'been granted to Forge dash in System Settings → Privacy & Security.'
    )
  }

  const size = source.thumbnail.getSize()
  return {
    data: source.thumbnail.toPNG().toString('base64'),
    width: size.width,
    height: size.height,
    // The real surface, not the captured one: this is what maps a click back.
    sourceWidth: bounds.width,
    sourceHeight: bounds.height,
    originX: bounds.x,
    originY: bounds.y
  }
}

/**
 * Maps a point on the frame the agent saw to a point on the desktop.
 *
 * The agent is looking at a downscaled image of one surface; the mouse lives in
 * whole-desktop coordinates. Without this every click lands somewhere else, and
 * on a multi-monitor setup somewhere else entirely.
 */
export function toScreenPoint(frame: Frame, x: number, y: number): { x: number; y: number } {
  const scale = frame.sourceWidth / Math.max(1, frame.width)
  return {
    x: Math.round(frame.originX + x * scale),
    y: Math.round(frame.originY + y * scale)
  }
}

/**
 * Where a source sits and how big it is.
 *
 * Only screens can be located: Electron does not report a window's position, so
 * a captured window is treated as if it filled its display. Clicking inside a
 * shared window is therefore only exact when that window is maximised — which
 * is why the picker recommends sharing a whole screen for anything involving
 * control.
 */
function surfaceBounds(sourceId: string): { x: number; y: number; width: number; height: number } {
  const displays = screen.getAllDisplays()

  if (sourceId.startsWith('screen:')) {
    // `screen:ZZ:0` — ZZ matches a Display id on the platforms that report one.
    const wanted = sourceId.split(':')[1]
    const match = displays.find((display) => String(display.id) === wanted)
    const display = match ?? screen.getPrimaryDisplay()

    return {
      x: display.bounds.x,
      y: display.bounds.y,
      width: Math.round(display.size.width * display.scaleFactor),
      height: Math.round(display.size.height * display.scaleFactor)
    }
  }

  const primary = screen.getPrimaryDisplay()
  return {
    x: primary.bounds.x,
    y: primary.bounds.y,
    width: Math.round(primary.size.width * primary.scaleFactor),
    height: Math.round(primary.size.height * primary.scaleFactor)
  }
}
