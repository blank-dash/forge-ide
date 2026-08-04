import type { ToolSchema } from '../../providers'
import {
  deleteFileTool,
  editFileTool,
  listDirTool,
  readFileTool,
  writeFileTool
} from './filesystem'
import { globTool, grepTool } from './search'
import { runCommandTool } from './shell'
import type { ToolDef } from './types'

type AnyTool = ToolDef<Record<string, never>>

export const BUILTIN_TOOLS = [
  readFileTool,
  writeFileTool,
  editFileTool,
  deleteFileTool,
  listDirTool,
  globTool,
  grepTool,
  runCommandTool
] as unknown as AnyTool[]

/**
 * Built-ins plus whatever MCP contributes this turn. MCP tools come and go with
 * their servers, so the list is assembled per call rather than cached.
 */
export function activeTools(mcpTools: AnyTool[], readOnlyOnly: boolean): AnyTool[] {
  return [...BUILTIN_TOOLS, ...mcpTools].filter((tool) => !readOnlyOnly || tool.readOnly)
}

export function findTool(tools: AnyTool[], name: string): AnyTool | undefined {
  return tools.find((tool) => tool.name === name)
}

export function toolSchemas(tools: AnyTool[]): ToolSchema[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters
  }))
}

export {
  ToolError,
  displayPath,
  isInside,
  objectSchema,
  type ToolContext,
  type ToolDef
} from './types'
export { buildProjectSnapshot } from './search'
export { shellInfo } from './shell'
