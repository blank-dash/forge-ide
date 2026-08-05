import { spawn, type ChildProcess } from 'node:child_process'

/**
 * Reading text aloud with the operating system's own voices.
 *
 * Not `speechSynthesis`: Chromium's speech API is backed by a service Electron
 * does not ship, so `getVoices()` returns an empty list and speaking silently
 * does nothing. The failure is invisible — the app looks like it is talking and
 * no sound comes out — which is worse than not offering it.
 *
 * So each platform's own synthesiser is driven directly. All of them are
 * already installed, cost nothing and need no network.
 */

export interface SystemVoice {
  name: string
  lang: string
}

/** One process per utterance, which makes stopping exact: kill it. */
let speaking: ChildProcess | null = null
let cachedVoices: SystemVoice[] | null = null

export function speechAvailable(): boolean {
  return process.platform === 'win32' || process.platform === 'darwin'
}

export async function systemVoices(): Promise<SystemVoice[]> {
  if (cachedVoices) return cachedVoices

  try {
    cachedVoices =
      process.platform === 'win32'
        ? await windowsVoices()
        : process.platform === 'darwin'
          ? await macVoices()
          : []
  } catch {
    cachedVoices = []
  }
  return cachedVoices
}

/**
 * Speaks, and resolves when it has finished or been stopped.
 *
 * Never rejects on a synthesiser that is simply absent: reading a reply aloud
 * failing must not turn into an error in the conversation.
 */
export async function speakSystem(text: string, voice: string, rate: number): Promise<void> {
  stopSystemSpeech()

  const clean = text.trim()
  if (!clean) return

  const child =
    process.platform === 'win32'
      ? speakWindows(clean, voice, rate)
      : process.platform === 'darwin'
        ? speakMac(clean, voice, rate)
        : null

  if (!child) return

  speaking = child
  await new Promise<void>((resolve) => {
    child.once('exit', () => resolve())
    child.once('error', () => resolve())
  })
  if (speaking === child) speaking = null
}

export function stopSystemSpeech(): void {
  const child = speaking
  speaking = null
  if (child && !child.killed) child.kill()
}

/* ------------------------------------------------------------------ */

function speakWindows(text: string, voice: string, rate: number): ChildProcess {
  // System.Speech maps rate onto -10..10, where 0 is normal. The multiplier
  // people expect (1x, 1.5x) has to be converted into that scale.
  const scaled = Math.round(Math.min(10, Math.max(-10, (rate - 1) * 10)))

  const script = [
    'Add-Type -AssemblyName System.Speech',
    '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer',
    `$s.Rate = ${scaled}`,
    voice ? `try { $s.SelectVoice(${psQuote(voice)}) } catch {}` : '',
    // Read from stdin rather than embedded in the script: an argument would
    // have to survive two levels of quoting, and any reply containing a quote
    // would either break the command or run part of itself.
    '$text = [Console]::In.ReadToEnd()',
    '$s.Speak($text)'
  ]
    .filter(Boolean)
    .join('; ')

  const child = spawn(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    { windowsHide: true }
  )
  child.stdin.end(text, 'utf8')
  return child
}

function speakMac(text: string, voice: string, rate: number): ChildProcess {
  // `say` takes words per minute; about 175 is its normal pace.
  const words = Math.round(Math.min(400, Math.max(80, 175 * rate)))
  const args = ['-r', String(words)]
  if (voice) args.push('-v', voice)

  const child = spawn('say', args)
  child.stdin.end(text, 'utf8')
  return child
}

async function windowsVoices(): Promise<SystemVoice[]> {
  const out = await run('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    'Add-Type -AssemblyName System.Speech; ' +
      '(New-Object System.Speech.Synthesis.SpeechSynthesizer).GetInstalledVoices() | ' +
      'ForEach-Object { $_.VoiceInfo.Name + "|" + $_.VoiceInfo.Culture.Name }'
  ])

  return out
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [name, lang] = line.split('|')
      return { name, lang: lang ?? '' }
    })
}

async function macVoices(): Promise<SystemVoice[]> {
  const out = await run('say', ['-v', '?'])

  return out
    .split(/\r?\n/)
    .map((line) => /^(.+?)\s{2,}([a-z]{2}_[A-Z]{2})/.exec(line.trim()))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => ({ name: match[1].trim(), lang: match[2] }))
}

function run(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true })
    let out = ''
    child.stdout.on('data', (chunk: Buffer) => {
      out += chunk.toString()
    })
    child.on('error', reject)
    child.on('exit', () => resolve(out))
  })
}

/** Single quotes, doubled to escape — the PowerShell literal-string rule. */
function psQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}
