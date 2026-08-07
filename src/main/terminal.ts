import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import type { WebContents } from 'electron'

export type TerminalBackend = 'pty' | 'pipe'

export interface TerminalHandle {
  id: string
  backend: TerminalBackend
  shell: string
  /** Set when the pty could not be loaded and we fell back to pipes. */
  degradedReason?: string
}

interface PtyProcess {
  onData(listener: (data: string) => void): void
  onExit(listener: (event: { exitCode: number }) => void): void
  write(data: string): void
  resize(cols: number, rows: number): void
  kill(): void
}

interface PtyModule {
  spawn(
    file: string,
    args: string[] | string,
    options: {
      name: string
      cols: number
      rows: number
      cwd: string
      env: NodeJS.ProcessEnv
      useConpty?: boolean
    }
  ): PtyProcess
}

interface Session {
  id: string
  backend: TerminalBackend
  pty?: PtyProcess
  child?: ChildProcessWithoutNullStreams
}

/** Resolved once: a failed native load must not be retried on every terminal. */
let ptyModule: PtyModule | null | undefined
let ptyError = ''

function loadPty(): PtyModule | null {
  if (ptyModule !== undefined) return ptyModule
  try {
    // Required lazily so a missing or ABI-mismatched binary degrades to pipes
    // instead of taking the whole app down at startup.
    ptyModule = require('@lydell/node-pty') as PtyModule
  } catch (error) {
    ptyError = (error as Error).message
    ptyModule = null
  }
  return ptyModule
}

/**
 * Terminal sessions backed by a real pty when one is available, so shell
 * prompts, colours, `vim`, `top` and password prompts all behave. If the
 * native binary cannot load, sessions fall back to pipes — degraded, but the
 * app still works.
 */
export class TerminalManager {
  private sessions = new Map<string, Session>()

  constructor(private readonly sender: () => WebContents | null) {}

  create(cwd: string, cols = 80, rows = 24): TerminalHandle {
    const id = randomUUID()
    const shell = resolveShell()
    const pty = loadPty()

    if (pty) {
      try {
        return this.createPty(pty, id, shell, cwd, cols, rows)
      } catch (error) {
        ptyError = (error as Error).message
      }
    }

    return this.createPipe(id, shell, cwd, ptyError || 'pty unavailable')
  }

  write(id: string, data: string): void {
    const session = this.sessions.get(id)
    if (!session) return
    if (session.pty) session.pty.write(data)
    else session.child?.stdin.write(data)
  }

  resize(id: string, cols: number, rows: number): void {
    const session = this.sessions.get(id)
    if (!session?.pty) return
    try {
      session.pty.resize(Math.max(cols, 2), Math.max(rows, 1))
    } catch {
      // The process can exit between a resize being queued and delivered.
    }
  }

  kill(id: string): void {
    const session = this.sessions.get(id)
    if (!session) return
    this.sessions.delete(id)
    try {
      session.pty?.kill()
      session.child?.kill()
    } catch {
      /* already gone */
    }
  }

  killAll(): void {
    for (const id of [...this.sessions.keys()]) this.kill(id)
  }

  /* ---------------- backends ---------------- */

  private createPty(
    pty: PtyModule,
    id: string,
    shell: string,
    cwd: string,
    cols: number,
    rows: number
  ): TerminalHandle {
    const term = pty.spawn(shell, shellArgs(shell), {
      name: 'xterm-256color',
      cols: Math.max(cols, 2),
      rows: Math.max(rows, 1),
      cwd,
      env: {
        ...process.env,
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor',
        FORGE_IDE: '1'
      }
    })

    term.onData((data) => this.send(id, data))
    term.onExit(({ exitCode }) => {
      this.send(id, `\r\n\x1b[38;5;244m[process exited with code ${exitCode}]\x1b[0m\r\n`)
      this.sessions.delete(id)
    })

    this.sessions.set(id, { id, backend: 'pty', pty: term })
    return { id, backend: 'pty', shell }
  }

  private createPipe(id: string, shell: string, cwd: string, reason: string): TerminalHandle {
    const child = spawn(shell, pipeArgs(shell), {
      cwd,
      windowsHide: true,
      env: { ...process.env, TERM: 'dumb', NO_COLOR: '1', GIT_PAGER: 'cat', PAGER: 'cat' }
    }) as ChildProcessWithoutNullStreams

    const forward = (chunk: Buffer): void =>
      // xterm expects CRLF; pipes give us bare LF.
      this.send(id, chunk.toString('utf8').replace(/(?<!\r)\n/g, '\r\n'))

    child.stdout.on('data', forward)
    child.stderr.on('data', forward)
    child.on('error', (error) => this.send(id, `\r\n[shell error] ${error.message}\r\n`))
    child.on('close', (code) => {
      this.send(id, `\r\n[shell exited with code ${code ?? 0}]\r\n`)
      this.sessions.delete(id)
    })

    this.sessions.set(id, { id, backend: 'pipe', child })
    return { id, backend: 'pipe', shell, degradedReason: reason }
  }

  private send(id: string, data: string): void {
    this.sender()?.send('terminal:data', { id, data })
  }
}

/** Prefers PowerShell 7 over Windows PowerShell, and the user's shell elsewhere. */
export function resolveShell(): string {
  if (process.platform !== 'win32') {
    return process.env.SHELL || (existsSync('/bin/zsh') ? '/bin/zsh' : '/bin/bash')
  }

  const pwsh = [
    `${process.env.ProgramFiles}\\PowerShell\\7\\pwsh.exe`,
    `${process.env.LOCALAPPDATA}\\Microsoft\\WindowsApps\\pwsh.exe`
  ].find((candidate) => existsSync(candidate))

  return (
    pwsh ??
    `${process.env.SystemRoot ?? 'C:\\Windows'}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`
  )
}

export function shellLabel(): string {
  const shell = resolveShell()
  const base = shell.split(/[\\/]/).pop() ?? shell
  return base.replace(/\.exe$/i, '')
}

function shellArgs(shell: string): string[] {
  return /pwsh|powershell/i.test(shell) ? ['-NoLogo'] : []
}

function pipeArgs(shell: string): string[] {
  if (/pwsh|powershell/i.test(shell)) return ['-NoProfile', '-NoLogo', '-Command', '-']
  return ['-s']
}
