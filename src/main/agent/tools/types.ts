import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { EditApproval, ImageBlock, PermissionRequest, ToolDisplay } from '@shared/types'
import type { ChangeTracker } from '../changes'

export interface ToolContext {
  /** Absolute workspace root. Relative paths resolve against it. */
  cwd: string
  readOnly: boolean
  editApproval: EditApproval
  /** Directories outside the workspace the user has already approved. */
  externalRoots: string[]
  /**
   * Paths the user named in their own message this session. Typing a path is
   * itself the authorisation, so these need no dialog.
   */
  sessionGrants: string[]
  signal: AbortSignal
  changes: ChangeTracker
  requestPermission(request: Omit<PermissionRequest, 'id'>): Promise<boolean>
  notifyFileChanged(absolutePath: string): void
  /**
   * Records how a file looked before it is written.
   *
   * Called by every tool that changes a file, before it does, and regardless of
   * the approval mode — the review screen's own record is skipped in `ask` mode
   * because each diff was already shown, but a turn still has to be undoable.
   */
  captureBefore(absolutePath: string): Promise<void>
}

export interface ToolOutcome {
  /** Text handed back to the model. */
  content: string
  display: ToolDisplay
  /** Images to show the model, sent as image blocks in the same turn. */
  images?: ImageBlock[]
}

export interface ToolDef<Input = Record<string, never>> {
  name: string
  description: string
  parameters: Record<string, unknown>
  /** Read-only tools are the only ones offered to the model in chat mode. */
  readOnly: boolean
  /** Short label shown in the transcript, e.g. `Read(src/app.ts)`. */
  title(input: Input): string
  run(input: Input, ctx: ToolContext): Promise<ToolOutcome>
}

export class ToolError extends Error {}

/**
 * Resolves a path the model asked for.
 *
 * Inside the workspace: allowed silently. Outside: allowed only after the user
 * approves it, which is what makes "here is a file on my machine, work on it"
 * possible without handing the agent the whole filesystem. Approving with
 * "always" remembers the parent directory for the rest of the session and
 * beyond.
 */
export async function resolveTarget(
  ctx: ToolContext,
  target: string,
  intent: 'read' | 'write'
): Promise<string> {
  if (!target || typeof target !== 'string') {
    throw new ToolError('A file path is required.')
  }

  const absolute = path.isAbsolute(target)
    ? path.normalize(target)
    : path.resolve(ctx.cwd, target)

  // Compare real paths, not textual ones: a symlink inside the workspace can
  // point anywhere, and a purely lexical check would wave it straight through.
  const real = await realPath(absolute)
  const realCwd = await realPath(ctx.cwd)
  if (isInside(realCwd, real)) return absolute

  if (ctx.externalRoots.some((root) => isInside(root, real))) return absolute
  if (ctx.sessionGrants.some((granted) => isInside(granted, real))) return absolute

  const parent = path.dirname(absolute)
  const approved = await ctx.requestPermission({
    toolName: 'external_path',
    kind: 'external',
    title: `${intent === 'read' ? 'Read' : 'Write'} outside the workspace`,
    detail:
      `${absolute}\n\n` +
      `This path is outside ${ctx.cwd}.\n` +
      `Choosing "always allow" grants access to everything under:\n  ${parent}`,
    suggestedRule: parent
  })

  if (!approved) {
    throw new ToolError(
      `Access to "${target}" was not granted. It lies outside the open workspace.`
    )
  }
  return absolute
}

/**
 * Resolves symlinks as far as the path actually exists. A file being created
 * has no real path yet, so we resolve the nearest existing ancestor and
 * re-attach the remainder — enough to catch a symlinked parent directory.
 */
async function realPath(target: string): Promise<string> {
  let head = target
  const tail: string[] = []

  for (let depth = 0; depth < 64; depth++) {
    try {
      return path.join(await fs.realpath(head), ...tail.reverse())
    } catch {
      const parent = path.dirname(head)
      if (parent === head) return target
      tail.push(path.basename(head))
      head = parent
    }
  }
  return target
}

export function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

/** Relative inside the workspace, absolute outside — matching what users expect. */
export function displayPath(cwd: string, absolute: string): string {
  if (!isInside(cwd, absolute)) return absolute
  const relative = path.relative(cwd, absolute)
  return relative === '' ? '.' : relative.split(path.sep).join('/')
}

/** Trims tool output so a runaway file cannot blow up the context window. */
export function truncate(text: string, maxChars = 30_000): string {
  if (text.length <= maxChars) return text
  const head = text.slice(0, maxChars)
  return `${head}\n\n… truncated ${text.length - maxChars} more characters. Narrow the request (offset/limit, a tighter glob, or a more specific pattern) to see the rest.`
}

export const string = (description: string) => ({ type: 'string', description })
export const number = (description: string) => ({ type: 'number', description })
export const boolean = (description: string) => ({ type: 'boolean', description })

export function objectSchema(
  properties: Record<string, unknown>,
  required: string[]
): Record<string, unknown> {
  return { type: 'object', properties, required }
}
