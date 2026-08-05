import type { McpServerConfig, McpServerStatus } from '@shared/types'
import { objectSchema, ToolError, type ToolDef } from '../agent/tools/types'
import { McpClient } from './client'

interface Entry {
  config: McpServerConfig
  client: McpClient
  status: McpServerStatus
  tools: ToolDef<Record<string, unknown>>[]
}

/** MCP tool names are namespaced so they cannot collide with the built-ins. */
export function qualify(serverId: string, toolName: string): string {
  return `mcp__${sanitize(serverId)}__${sanitize(toolName)}`
}

function sanitize(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '_')
}

/**
 * Owns the lifecycle of every configured MCP server and exposes their tools to
 * the agent. A server that fails to start is reported, never fatal — a broken
 * entry in the config must not take the app down with it.
 */
export class McpManager {
  private entries = new Map<string, Entry>()
  private listeners = new Set<(statuses: McpServerStatus[]) => void>()

  onStatus(listener: (statuses: McpServerStatus[]) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  statuses(): McpServerStatus[] {
    return [...this.entries.values()].map((entry) => entry.status)
  }

  tools(): ToolDef<Record<string, unknown>>[] {
    return [...this.entries.values()]
      .filter((entry) => entry.status.state === 'ready')
      .flatMap((entry) => entry.tools)
  }

  /** Starts newly enabled servers and stops ones that were disabled or removed. */
  async sync(configs: McpServerConfig[]): Promise<void> {
    const wanted = new Map(configs.filter((config) => config.enabled).map((c) => [c.id, c]))

    for (const [id, entry] of [...this.entries]) {
      const next = wanted.get(id)
      if (!next || hasChanged(entry.config, next)) {
        entry.client.stop()
        this.entries.delete(id)
      }
    }

    this.emit()

    await Promise.all(
      [...wanted.values()]
        .filter((config) => !this.entries.has(config.id))
        .map((config) => this.start(config))
    )
  }

  stopAll(): void {
    for (const entry of this.entries.values()) entry.client.stop()
    this.entries.clear()
    this.emit()
  }

  async restart(id: string, configs: McpServerConfig[]): Promise<void> {
    this.entries.get(id)?.client.stop()
    this.entries.delete(id)
    const config = configs.find((entry) => entry.id === id)
    if (config?.enabled) await this.start(config)
    else this.emit()
  }

  private async start(config: McpServerConfig): Promise<void> {
    const client = new McpClient(config)
    const entry: Entry = {
      config,
      client,
      status: { id: config.id, name: config.name, state: 'starting', tools: [] },
      tools: []
    }
    this.entries.set(config.id, entry)
    this.emit()

    try {
      await client.start()
      const discovered = await client.listTools()

      entry.tools = discovered.map((tool) => this.wrap(config, tool))
      entry.status = {
        id: config.id,
        name: config.name,
        state: 'ready',
        tools: discovered.map((tool) => ({ name: tool.name, description: tool.description }))
      }
    } catch (error) {
      client.stop()
      entry.tools = []
      entry.status = {
        id: config.id,
        name: config.name,
        state: 'error',
        error: (error as Error).message,
        tools: []
      }
    }

    this.emit()
  }

  private wrap(
    config: McpServerConfig,
    tool: { name: string; description: string; inputSchema: unknown }
  ): ToolDef<Record<string, unknown>> {
    const qualified = qualify(config.id, tool.name)
    const autoApproved = config.autoApproveTools.includes(tool.name)

    return {
      name: qualified,
      description: `[${config.name}] ${tool.description || tool.name}`,
      parameters: normaliseSchema(tool.inputSchema),
      // MCP tools can do anything; treat them all as side-effecting so chat
      // mode never exposes them.
      readOnly: false,
      title: (input) => `${config.name}·${tool.name}(${summarise(input)})`,

      run: async (input, ctx) => {
        // Always routed through the permission layer, even for a tool the
        // server config auto-approves. Skipping it outright meant deny rules
        // were never consulted, and an unattended scheduled task had no way to
        // refuse an MCP call that its permission level forbids — MCP servers
        // can do anything, shell execution included.
        const approved = await ctx.requestPermission({
          toolName: qualified,
          kind: 'mcp',
          title: `${config.name} · ${tool.name}`,
          detail: `${tool.description || '(no description)'}\n\n${JSON.stringify(input ?? {}, null, 2)}`,
          suggestedRule: `${qualified}(*)`,
          preApproved: autoApproved
        })
        if (!approved) throw new ToolError('User rejected the MCP tool call.')

        const entry = this.entries.get(config.id)
        if (!entry || entry.status.state !== 'ready') {
          throw new ToolError(`MCP server "${config.name}" is not running.`)
        }

        const result = await entry.client.callTool(tool.name, input ?? {})
        if (result.isError) throw new ToolError(result.content)

        const lines = result.content.split('\n').length
        return {
          content: result.content,
          display: {
            kind: 'text',
            summary: `${lines} line${lines === 1 ? '' : 's'} from ${config.name}`,
            body: result.content
          }
        }
      }
    }
  }

  private emit(): void {
    const snapshot = this.statuses()
    for (const listener of this.listeners) listener(snapshot)
  }
}

function hasChanged(a: McpServerConfig, b: McpServerConfig): boolean {
  return JSON.stringify(a) !== JSON.stringify(b)
}

/** Guards against servers that advertise a missing or malformed input schema. */
function normaliseSchema(schema: unknown): Record<string, unknown> {
  if (schema && typeof schema === 'object' && !Array.isArray(schema)) {
    const record = schema as Record<string, unknown>
    if (record.type === 'object') {
      return { ...record, properties: record.properties ?? {} }
    }
  }
  return objectSchema({}, [])
}

function summarise(input: Record<string, unknown>): string {
  const text = JSON.stringify(input ?? {})
  return text.length > 70 ? `${text.slice(0, 67)}…` : text === '{}' ? '' : text
}
