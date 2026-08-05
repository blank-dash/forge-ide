/**
 * Integration check for live-mode capture, run under Electron.
 *
 *   npm run check:live
 *
 * The part worth checking is the coordinate mapping. A frame the agent sees is
 * a downscaled image of one surface; the mouse lives in whole-desktop
 * coordinates. If the mapping is off, every click lands somewhere else — and on
 * a second monitor, somewhere else entirely. Nothing here clicks anything.
 */
import assert from 'node:assert/strict'
import { app, BrowserWindow } from 'electron'
import { captureFrame, listSources, toScreenPoint, type Frame } from '../src/main/live/capture'
import { LiveSession } from '../src/main/live/session'

let failures = 0
function check(name: string, fn: () => void): void {
  try {
    fn()
    console.log(`  ok  ${name}`)
  } catch (error) {
    failures += 1
    console.error(`  FAIL ${name}\n       ${(error as Error).message}`)
  }
}

async function expectRejection(name: string, fn: () => Promise<unknown>, match: RegExp) {
  try {
    await fn()
    check(name, () => assert.fail('expected this to be refused'))
  } catch (error) {
    check(name, () => assert.match((error as Error).message, match))
  }
}

app.whenReady().then(async () => {
  // A window exists only because capture needs an app that has finished
  // starting; nothing is shown.
  new BrowserWindow({ show: false, width: 400, height: 300 })

  console.log('live mode')

  const sources = await listSources()

  check('screens are offered as capture sources', () => {
    assert.ok(sources.length > 0, 'no capturable sources at all')
    assert.ok(
      sources.some((source) => source.kind === 'screen'),
      'no screen among the sources'
    )
  })

  check('every source is named and identified', () => {
    for (const source of sources) {
      assert.ok(source.id, 'a source has no id')
      assert.ok(source.name.trim(), `source ${source.id} has no name`)
    }
  })

  const screenSource = sources.find((source) => source.kind === 'screen')
  assert.ok(screenSource, 'cannot continue without a screen')

  const frame = await captureFrame(screenSource.id)

  check('a frame comes back with real pixels', () => {
    assert.ok(frame.data.length > 1000, `frame was ${frame.data.length} bytes of base64`)
    assert.ok(frame.width > 0 && frame.height > 0)
    assert.ok(frame.sourceWidth >= frame.width)
  })

  check('the frame is scaled down to something a model can afford to look at', () => {
    assert.ok(frame.width <= 1280, `frame is ${frame.width}px wide`)
  })

  check('scaling preserves the aspect ratio', () => {
    const sourceRatio = frame.sourceWidth / frame.sourceHeight
    const frameRatio = frame.width / frame.height
    assert.ok(
      Math.abs(sourceRatio - frameRatio) < 0.02,
      `source ${sourceRatio.toFixed(3)} vs frame ${frameRatio.toFixed(3)}`
    )
  })

  check('the corners of the frame map to the corners of the surface', () => {
    const topLeft = toScreenPoint(frame, 0, 0)
    assert.deepEqual(topLeft, { x: frame.originX, y: frame.originY })

    const bottomRight = toScreenPoint(frame, frame.width, frame.height)
    const scale = frame.sourceWidth / frame.width
    assert.equal(bottomRight.x, Math.round(frame.originX + frame.width * scale))
    assert.ok(
      Math.abs(bottomRight.x - (frame.originX + frame.sourceWidth)) <= 2,
      `bottom-right x drifted: ${bottomRight.x} vs ${frame.originX + frame.sourceWidth}`
    )
  })

  check('the middle of the frame maps to the middle of the surface', () => {
    const middle = toScreenPoint(frame, frame.width / 2, frame.height / 2)
    assert.ok(Math.abs(middle.x - (frame.originX + frame.sourceWidth / 2)) <= 2)
    assert.ok(Math.abs(middle.y - (frame.originY + frame.sourceHeight / 2)) <= 2)
  })

  check('a synthetic frame maps exactly, whatever the scale', () => {
    // Pure arithmetic, so it does not depend on this machine's displays.
    const synthetic: Frame = {
      data: '',
      width: 640,
      height: 360,
      sourceWidth: 2560,
      sourceHeight: 1440,
      originX: 1920,
      originY: -120
    }

    assert.deepEqual(toScreenPoint(synthetic, 0, 0), { x: 1920, y: -120 })
    assert.deepEqual(toScreenPoint(synthetic, 320, 180), { x: 1920 + 1280, y: -120 + 720 })
    assert.deepEqual(toScreenPoint(synthetic, 640, 360), { x: 1920 + 2560, y: -120 + 1440 })
  })

  /* ---------------- session rules ---------------- */

  const statuses: unknown[] = []
  const live = new LiveSession(
    (status) => statuses.push(status),
    () => undefined
  )

  await expectRejection('nothing can be looked at before a session starts', () => live.look(), /not running/i)

  await live.start(screenSource.id, 'watch')

  check('starting reports what is being shared', () => {
    assert.equal(live.isActive, true)
    assert.equal(live.current().sourceName, screenSource.name)
    assert.equal(live.canControl, false)
    assert.ok(statuses.length > 0, 'the status change was not published')
  })

  await expectRejection(
    'a watch-only session refuses to click',
    () => live.click(10, 10, 'left', false),
    /watch-only/i
  )
  await expectRejection(
    'a watch-only session refuses to type',
    () => live.typeText('hello'),
    /watch-only/i
  )

  await live.look()
  live.stop()

  check('stopping clears everything', () => {
    assert.equal(live.isActive, false)
    assert.equal(live.canControl, false)
    assert.equal(live.current().sourceName, '')
  })

  await expectRejection('a stopped session refuses to look', () => live.look(), /not running/i)

  // Control sessions are started but never driven: this check must not take
  // over the machine of whoever runs it.
  await live.start(screenSource.id, 'control')

  check('a control session says so', () => {
    assert.equal(live.canControl, true)
  })

  await expectRejection(
    'coordinates are refused before anything has been seen',
    () => live.click(5, 5, 'left', false),
    /look at the screen first/i
  )

  const seen = await live.look()
  await expectRejection(
    'coordinates outside the frame are refused',
    () => live.click(seen.width + 50, 5, 'left', false),
    /outside the frame/i
  )

  live.stop()

  console.log(failures === 0 ? '\nlive check passed' : `\n${failures} failed`)
  app.exit(failures === 0 ? 0 : 1)
})
