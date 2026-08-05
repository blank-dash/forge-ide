/**
 * Check that the live-mode input helper starts and accepts commands.
 *
 * Run directly under Node — it needs no Electron, only PowerShell:
 *
 *   npm run check:input
 *
 * Deliberately gentle. It reads where the cursor already is, moves it back to
 * exactly that spot, and types nothing: enough to prove the P/Invoke surface
 * loads and commands round-trip, without taking over the machine of whoever is
 * running the check.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createInputBackend } from '../src/main/live/input'

function cursorPosition(): { x: number; y: number } {
  const out = execFileSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-Command',
      'Add-Type -AssemblyName System.Windows.Forms; ' +
        '$p=[System.Windows.Forms.Cursor]::Position; "$($p.X),$($p.Y)"'
    ],
    { encoding: 'utf8', windowsHide: true }
  )
  const [x, y] = out.trim().split(',').map(Number)
  return { x, y }
}

async function main(): Promise<void> {
  console.log('live input helper')

  const backend = createInputBackend()

  if (process.platform !== 'win32') {
    assert.equal(backend.available, false)
    assert.ok(backend.reason)
    console.log(`  ok  reports itself unavailable on ${process.platform}, with a reason`)
    console.log('\ninput check passed (nothing to drive on this platform)')
    return
  }

  assert.equal(backend.available, true)

  const before = cursorPosition()
  console.log(`  ..  cursor is at ${before.x},${before.y}`)

  /*
   * Retried, because the failure this can produce is not the product's.
   *
   * Whoever runs this is at the machine and may move the mouse in the window
   * between commanding a position and reading it back. One attempt landing is
   * proof the helper reaches the desktop; a miss proves only that a hand moved.
   */
  let landed = false
  let lastSeen = before

  for (let attempt = 0; attempt < 4 && !landed; attempt++) {
    const target = { x: before.x + 1 + attempt, y: before.y }
    await backend.move(target.x, target.y)
    await new Promise((resolve) => setTimeout(resolve, 300))

    lastSeen = cursorPosition()
    landed = lastSeen.x === target.x && lastSeen.y === target.y
  }

  assert.ok(
    landed,
    'the cursor never landed where it was told to, over four attempts' +
      `
       last seen at ${lastSeen.x},${lastSeen.y}` +
      `
       helper said: ${
        (backend as { lastError?: () => string }).lastError?.() || '(nothing)'
      }`
  )
  console.log('  ok  the helper moves the cursor where it is told')

  // Best effort, deliberately unasserted — see above.
  await backend.move(before.x, before.y)
  await new Promise((resolve) => setTimeout(resolve, 200))
  console.log('  ok  a second command on the same process still works')

  // The remaining commands are exercised without side effects: an empty string
  // types nothing, an unrecognised key name falls through every branch, and a
  // zero-notch scroll moves nothing. All three still run the marshalling that
  // would fail if the native declarations were wrong, and the helper reports
  // any exception on stderr.
  await backend.typeText('')
  await backend.pressKey('__nothing__', [])
  await backend.scroll(before.x, before.y, 0)
  await new Promise((resolve) => setTimeout(resolve, 500))

  const complaints = (backend as { lastError?: () => string }).lastError?.() ?? ''
  assert.equal(complaints, '', `the helper reported errors:\n${complaints}`)
  console.log('  ok  typing, key and scroll commands run without complaint')

  backend.dispose()
  console.log('\ninput check passed')
}

main().then(
  () => process.exit(0),
  (error: Error) => {
    console.error(`\ninput check FAILED\n  ${error.message}`)
    process.exit(1)
  }
)
