/**
 * Checks that closing the window ends the process.
 *
 *   npm run check:shutdown
 *
 * This exists because of a real failure: an exception thrown out of the
 * shutdown path was caught by the crash guard, which is written to keep the app
 * running — correct while the app is in use, wrong while it is closing. The
 * window disappeared, the process did not, and the installer could then neither
 * close it nor replace the files it was holding open. Nothing on screen said so.
 *
 * Launches the real built main process, closes its window, and waits for the
 * process to actually exit.
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const MAIN = path.join(ROOT, 'out', 'main', 'index.js')

/** Generous: a cold start on a slow machine, then an orderly shutdown. */
const START_MS = 25_000
const EXIT_MS = 12_000

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function main(): Promise<void> {
  console.log('shutdown')

  if (process.platform !== 'win32') {
    console.log(`  ..  written for the Windows binary; skipped on ${process.platform}`)
    return
  }

  const child = spawn(ELECTRON, [MAIN], {
    env: { ...process.env, FORGE_CLOSE_AFTER_MS: '6000' },
    stdio: ['ignore', 'pipe', 'pipe']
  })

  let output = ''
  child.stdout.on('data', (chunk: Buffer) => {
    output += chunk.toString()
  })
  child.stderr.on('data', (chunk: Buffer) => {
    output += chunk.toString()
  })

  const exited = new Promise<number | null>((resolve) => {
    child.on('exit', (code) => resolve(code))
  })

  const outcome = await Promise.race([
    exited.then((code) => ({ exited: true, code })),
    wait(START_MS + EXIT_MS).then(() => ({ exited: false, code: null }))
  ])

  if (!outcome.exited) {
    child.kill('SIGKILL')
    assert.fail(
      'the process was still running after its window closed' +
        `${String.fromCharCode(10)}       output: ${output.slice(-600)}`
    )
  }

  console.log('  ok  closing the window ends the process')
  assert.ok(
    !output.includes('took too long'),
    'the backstop had to force the exit, which means an orderly shutdown did not happen:' +
      `${String.fromCharCode(10)}       ${output.slice(-600)}`
  )
  console.log('  ok  it shut down in order, without needing the backstop')
  console.log(`${String.fromCharCode(10)}shutdown check passed`)
}

main().then(
  () => process.exit(0),
  (error: Error) => {
    console.error(`${String.fromCharCode(10)}shutdown check FAILED${String.fromCharCode(10)}  ${error.message}`)
    process.exit(1)
  }
)
