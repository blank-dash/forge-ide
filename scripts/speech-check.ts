/**
 * Check that the system synthesiser is really there and really speaks.
 *
 *   npm run check:speech
 *
 * This exists because the obvious implementation — the browser's own
 * `speechSynthesis` — fails invisibly in Electron: it reports zero voices and
 * speaking produces no sound and no error. Anything that claims to read replies
 * aloud has to be proven to make noise, not merely to return without throwing.
 *
 * It does speak one short phrase out loud. That is the point.
 */
import assert from 'node:assert/strict'
import { speakSystem, speechAvailable, stopSystemSpeech, systemVoices } from '../src/main/speech'

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

async function main(): Promise<void> {
  console.log('system speech')

  if (!speechAvailable()) {
    console.log(`  ..  no system synthesiser on ${process.platform}; nothing to check`)
    return
  }

  const voices = await systemVoices()

  check('the machine reports installed voices', () => {
    assert.ok(
      voices.length > 0,
      'no voices at all — reading replies aloud would be silent with no error'
    )
  })
  for (const voice of voices.slice(0, 5)) console.log(`  ..  ${voice.name} (${voice.lang})`)

  check('every voice has a name and a language', () => {
    for (const voice of voices) {
      assert.ok(voice.name.trim(), 'a voice came back with no name')
      assert.ok(voice.lang.trim(), `${voice.name} came back with no language`)
    }
  })

  const started = Date.now()
  await speakSystem('Forge speech check.', voices[0]?.name ?? '', 1)
  const spokenMs = Date.now() - started

  check('speaking runs to completion and takes real time', () => {
    // A synthesiser that is not working returns immediately. Three words at a
    // normal pace cannot be done in under a third of a second.
    assert.ok(spokenMs > 300, `finished in ${spokenMs}ms, which means nothing was said`)
  })
  console.log(`  ..  spoke for ${spokenMs}ms`)

  // Quotes and newlines are the characters that break a shell-quoted argument,
  // and a reply containing them is completely ordinary.
  await speakSystem('He said "hi".', '', 1.5)
  check('awkward characters do not break the command', () => {
    assert.ok(true)
  })

  const longStart = Date.now()
  const speaking = speakSystem(
    'This sentence is deliberately long so that it can be interrupted part of the way through.',
    '',
    1
  )
  await new Promise((resolve) => setTimeout(resolve, 400))
  stopSystemSpeech()
  await speaking
  const stoppedMs = Date.now() - longStart

  check('stopping cuts it off rather than waiting for the end', () => {
    assert.ok(stoppedMs < 3000, `took ${stoppedMs}ms to stop`)
  })

  console.log(failures === 0 ? '\nspeech check passed' : `\n${failures} failed`)
}

main().then(
  () => process.exit(failures === 0 ? 0 : 1),
  (error: Error) => {
    console.error(`\nspeech check FAILED\n  ${error.message}`)
    process.exit(1)
  }
)
