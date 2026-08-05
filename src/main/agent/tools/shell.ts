import { spawn } from 'node:child_process'
import { number, objectSchema, string, ToolError, truncate, type ToolDef } from './types'

const DEFAULT_TIMEOUT_MS = 120_000
const MAX_TIMEOUT_MS = 600_000
/** How long a killed command gets to actually die before it is abandoned. */
const ABANDON_GRACE_MS = 1500

const MAX_OUTPUT_CHARS = 60_000

/** Commands we refuse outright, regardless of permission mode. */
const BLOCKED = [
  /\brm\s+(-[a-z]*[rf][a-z]*\s+)*\/(\s|$)/i,
  /\bmkfs\b/i,
  /\bdd\s+if=.*of=\/dev\//i,
  /Remove-Item\s+.*-Recurse.*\b[A-Z]:\\?\s*$/i,
  /\bformat\s+[a-z]:/i,
  /:\(\)\s*\{\s*:\|:&\s*\}\s*;:/
]

interface ShellInput {
  command: string
  timeout_ms?: number
  description?: string
}

export function shellInfo(): { file: string; args: string[]; label: string } {
  if (process.platform === 'win32') {
    return {
      file: 'powershell.exe',
      args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command'],
      label: 'PowerShell'
    }
  }
  return { file: '/bin/bash', args: ['-lc'], label: 'bash' }
}

export const runCommandTool: ToolDef<ShellInput> = {
  name: 'run_command',
  description: `Run a shell command in the workspace root using ${shellInfo().label}. ` +
    'Use it for builds, tests, linters, git and package managers. ' +
    'Prefer the dedicated file tools for reading, writing and searching — they are faster and safer. ' +
    'Interactive commands are not supported; there is no TTY.',
  parameters: objectSchema(
    {
      command: string('The command line to execute.'),
      timeout_ms: number('Timeout in milliseconds. Defaults to 120000, max 600000.'),
      description: string('Short description of what the command does, shown to the user.')
    },
    ['command']
  ),
  readOnly: false,
  title: (input) => `Bash(${input.command.split('\n')[0].slice(0, 80)})`,

  async run(input, ctx) {
    const command = (input.command ?? '').trim()
    if (!command) throw new ToolError('command is required.')

    for (const pattern of BLOCKED) {
      if (pattern.test(command)) {
        throw new ToolError(
          'This command is blocked because it looks destructive to the whole system. Run it yourself if you really mean it.'
        )
      }
    }

    const approved = await ctx.requestPermission({
      toolName: 'run_command',
      kind: 'shell',
      title: input.description?.trim() || 'Run command',
      detail: command,
      suggestedRule: `Bash(${command.split(/\s+/).slice(0, 2).join(' ')} *)`
    })
    if (!approved) throw new ToolError('User rejected the command.')

    const timeout = Math.min(input.timeout_ms ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS)
    const result = await execute(command, ctx.cwd, timeout, ctx.signal)

    const parts: string[] = []
    if (result.stdout) parts.push(result.stdout)
    if (result.stderr) parts.push(result.stderr.trim() ? `[stderr]\n${result.stderr}` : '')
    const output = parts.filter(Boolean).join('\n').trim() || '(no output)'

    const status = result.timedOut
      ? `Timed out after ${timeout} ms`
      : `Exit code ${result.code}`

    return {
      content: truncate(`${status}\n\n${output}`, MAX_OUTPUT_CHARS),
      display: {
        kind: 'shell',
        summary:
          result.code === 0 && !result.timedOut
            ? `Exit 0 · ${countLines(output)} lines`
            : `${status} · ${countLines(output)} lines`,
        body: output
      }
    }
  }
}

interface ExecResult {
  code: number
  stdout: string
  stderr: string
  timedOut: boolean
}

function execute(
  command: string,
  cwd: string,
  timeout: number,
  signal: AbortSignal
): Promise<ExecResult> {
  return new Promise((resolve) => {
    const { file, args } = shellInfo()
    const child = spawn(file, [...args, command], {
      cwd,
      windowsHide: true,
      // A group of its own, so stopping can take the whole tree rather than
      // only the shell. Windows has no process groups; taskkill /T covers it.
      detached: process.platform !== 'win32',
      env: { ...process.env, FORGE_IDE: '1', GIT_PAGER: 'cat', PAGER: 'cat', NO_COLOR: '1' }
    })

    let stdout = ''
    let stderr = ''
    let timedOut = false
    let settled = false

    const finish = (code: number): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      resolve({ code, stdout, stderr, timedOut })
    }

    /**
     * Kills the whole tree, not just the shell.
     *
     * `child.kill` reaches one process. The command runs inside a shell, which
     * usually has children of its own, and on Windows a signal to the shell
     * leaves every one of them running.
     */
    const kill = (): void => {
      if (child.pid && process.platform === 'win32') {
        // /T takes the descendants with it, /F does not ask nicely.
        spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
          windowsHide: true,
          stdio: 'ignore'
        }).on('error', () => undefined)
        return
      }

      try {
        // Negative pid is the process group, which is why it was detached.
        if (child.pid) process.kill(-child.pid, 'SIGTERM')
      } catch {
        child.kill('SIGTERM')
      }
      setTimeout(() => {
        try {
          if (child.pid) process.kill(-child.pid, 'SIGKILL')
        } catch {
          child.kill('SIGKILL')
        }
      }, 2000).unref?.()
    }

    const timer = setTimeout(() => {
      timedOut = true
      kill()
      // Settled on a grace timer rather than waiting for 'close'. A grandchild
      // that inherited the pipes holds them open after its parent is gone, and
      // 'close' waits for the pipes — so without this the promise never
      // resolves and the turn cannot end.
      setTimeout(() => finish(-1), ABANDON_GRACE_MS).unref?.()
    }, timeout)

    const onAbort = (): void => {
      stderr += `${'\n'}[stopped by the user]`
      kill()
      // Same reason. Stop has to mean stop even when something downstream is
      // still holding a pipe open.
      setTimeout(() => finish(-1), ABANDON_GRACE_MS).unref?.()
    }
    signal.addEventListener('abort', onAbort, { once: true })

    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdout.length < MAX_OUTPUT_CHARS * 2) stdout += chunk.toString('utf8')
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < MAX_OUTPUT_CHARS) stderr += chunk.toString('utf8')
    })

    child.on('error', (error) => {
      stderr += `\n${error.message}`
      finish(-1)
    })
    child.on('close', (code) => finish(code ?? -1))
  })
}

function countLines(text: string): number {
  return text ? text.split('\n').length : 0
}
