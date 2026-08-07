import { spawn, type ChildProcess } from 'node:child_process'
import type { McpServerConfig } from '@shared/types'
import { readSse, safeParse } from '../providers/sse'

const PROTOCOL_VERSION = '2024-11-05'
const REQUEST_TIMEOUT_MS = 60_000
const START_TIMEOUT_MS = 30_000

interface JsonRpcResponse {
  jsonrpc: '2.0'
  id?: number | string
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}

export interface McpCallResult {
  content: string
  isError: boolean
}

/**
 * A deliberately small MCP client: initialize, tools/list, tools/call.
 *
 * That is the whole surface Forge needs — resources and prompts are not wired
 * into the agent loop, so pretending to support them would be worse than not.
 */
export class McpClient {
  private child: ChildProcess | null = null
  private pending = new Map<number | string, PendingCall>()
  private nextId = 1
  private buffer = ''
  private stderrTail = ''
  private started = false
  /** Session id handed out by a streamable-HTTP server, if any. */
  private httpSession: string | null = null

  constructor(private readonly config: McpServerConfig) {}

  get id(): string {
    return this.config.id
  }

  async start(): Promise<void> {
    if (this.started) return

    if (this.config.transport === 'stdio') {
      await this.startStdio()
    }

    const init = (await this.request(
      'initialize',
      {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        clientInfo: { name: 'Forge', version: '0.1.0' }
      },
      START_TIMEOUT_MS
    )) as { protocolVersion?: string } | undefined

    // Notification, not a request — no response comes back for this one.
    await this.notify('notifications/initialized')

    if (init?.protocolVersion && init.protocolVersion !== PROTOCOL_VERSION) {
      // Servers are allowed to negotiate down; nothing we send depends on the
      // difference, so this is informational only.
    }

    this.started = true
  }

  async listTools(): Promise<Array<{ name: string; description: string; inputSchema: unknown }>> {
    const result = (await this.request('tools/list', {})) as
      { tools?: Array<{ name: string; description?: string; inputSchema?: unknown }> } | undefined

    return (result?.tools ?? []).map((tool) => ({
      name: tool.name,
      description: tool.description ?? '',
      inputSchema: tool.inputSchema ?? { type: 'object', properties: {} }
    }))
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<McpCallResult> {
    const result = (await this.request('tools/call', { name, arguments: args })) as
      { content?: Array<{ type: string; text?: string }>; isError?: boolean } | undefined

    const text = (result?.content ?? [])
      .map((part) => (part.type === 'text' ? (part.text ?? '') : `[${part.type}]`))
      .join('\n')
      .trim()

    return { content: text || '(no output)', isError: result?.isError === true }
  }

  stop(): void {
    for (const [, call] of this.pending) {
      call.reject(new Error('MCP server stopped.'))
    }
    this.pending.clear()
    this.child?.kill()
    this.child = null
    this.started = false
  }

  /* ---------------- transports ---------------- */

  private startStdio(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.config.command.trim()) {
        reject(new Error('No command configured for this stdio server.'))
        return
      }

      const child = spawn(this.config.command, this.config.args, {
        env: { ...process.env, ...this.config.env },
        windowsHide: true,
        // npx/npm/uvx on Windows are .cmd shims that cannot be spawned directly.
        shell: process.platform === 'win32'
      })

      let settled = false
      const fail = (error: Error): void => {
        if (settled) return
        settled = true
        reject(error)
      }

      child.on('error', (error) => fail(new Error(`Failed to start: ${error.message}`)))
      child.on('exit', (code) => {
        this.started = false
        const detail = this.stderrTail.trim().slice(-500)
        fail(new Error(`Process exited with code ${code}${detail ? `\n${detail}` : ''}`))
        for (const [, call] of this.pending) {
          call.reject(new Error(`MCP server exited (code ${code}).`))
        }
        this.pending.clear()
      })

      child.stdout?.on('data', (chunk: Buffer) => this.consume(chunk.toString('utf8')))
      child.stderr?.on('data', (chunk: Buffer) => {
        // Many servers log routine information to stderr; keep only the tail
        // so a chatty server cannot grow unbounded.
        this.stderrTail = (this.stderrTail + chunk.toString('utf8')).slice(-4000)
      })

      this.child = child

      // stdio has no readiness signal; initialize() is the real handshake.
      setTimeout(() => {
        if (!settled) {
          settled = true
          resolve()
        }
      }, 60)
    })
  }

  /** Feeds newline-delimited JSON-RPC messages from the child's stdout. */
  private consume(text: string): void {
    this.buffer += text
    let newline = this.buffer.indexOf('\n')

    while (newline !== -1) {
      const line = this.buffer.slice(0, newline).trim()
      this.buffer = this.buffer.slice(newline + 1)
      if (line) this.dispatch(line)
      newline = this.buffer.indexOf('\n')
    }
  }

  private dispatch(line: string): void {
    const message = safeParse<JsonRpcResponse>(line)
    if (!message || message.id === undefined) return // notification or noise

    const call = this.pending.get(message.id)
    if (!call) return
    this.pending.delete(message.id)
    clearTimeout(call.timer)

    if (message.error) {
      call.reject(new Error(`${message.error.message} (code ${message.error.code})`))
    } else {
      call.resolve(message.result)
    }
  }

  private async notify(method: string, params: unknown = {}): Promise<void> {
    const payload = { jsonrpc: '2.0', method, params }

    if (this.config.transport === 'stdio') {
      this.child?.stdin?.write(`${JSON.stringify(payload)}\n`)
      return
    }

    await fetch(this.config.url, {
      method: 'POST',
      headers: this.httpHeaders(),
      body: JSON.stringify(payload)
    }).catch(() => undefined)
  }

  private request(method: string, params: unknown, timeout = REQUEST_TIMEOUT_MS): Promise<unknown> {
    const id = this.nextId++
    const payload = { jsonrpc: '2.0', id, method, params }

    if (this.config.transport === 'http') return this.httpRequest(payload, timeout)

    return new Promise((resolve, reject) => {
      if (!this.child?.stdin?.writable) {
        reject(new Error('MCP server is not running.'))
        return
      }

      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Timed out after ${timeout} ms waiting for ${method}.`))
      }, timeout)

      this.pending.set(id, { resolve, reject, timer })
      this.child.stdin.write(`${JSON.stringify(payload)}\n`)
    })
  }

  private async httpRequest(payload: unknown, timeout: number): Promise<unknown> {
    if (!this.config.url.trim()) throw new Error('No URL configured for this HTTP server.')

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeout)

    try {
      const res = await fetch(this.config.url, {
        method: 'POST',
        signal: controller.signal,
        headers: this.httpHeaders(),
        body: JSON.stringify(payload)
      })

      if (!res.ok) {
        const detail = await res.text().catch(() => '')
        throw new Error(`HTTP ${res.status}. ${detail.slice(0, 300)}`)
      }

      const session = res.headers.get('mcp-session-id')
      if (session) this.httpSession = session

      const contentType = res.headers.get('content-type') ?? ''

      // Streamable HTTP answers a request either with a plain JSON body or with
      // an SSE stream whose first matching frame carries the result.
      if (contentType.includes('text/event-stream') && res.body) {
        for await (const frame of readSse(res.body)) {
          const message = safeParse<JsonRpcResponse>(frame.data)
          if (!message || message.id === undefined) continue
          if (message.error) throw new Error(message.error.message)
          return message.result
        }
        throw new Error('Stream ended without a response.')
      }

      const message = (await res.json()) as JsonRpcResponse
      if (message.error) throw new Error(message.error.message)
      return message.result
    } finally {
      clearTimeout(timer)
    }
  }

  private httpHeaders(): Record<string, string> {
    return {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(this.httpSession ? { 'mcp-session-id': this.httpSession } : {}),
      ...this.config.headers
    }
  }
}

interface PendingCall {
  resolve(value: unknown): void
  reject(error: Error): void
  timer: NodeJS.Timeout
}
