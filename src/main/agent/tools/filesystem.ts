import { promises as fs } from 'node:fs'
import path from 'node:path'
import { countChanges, renderDiff } from '../diff'
import {
  boolean,
  displayPath,
  isInside,
  number,
  objectSchema,
  resolveTarget,
  string,
  ToolError,
  truncate,
  type ToolContext,
  type ToolDef,
  type ToolOutcome
} from './types'

const MAX_READ_BYTES = 2_000_000

interface ReadInput {
  path: string
  offset?: number
  limit?: number
}

export const readFileTool: ToolDef<ReadInput> = {
  name: 'read_file',
  description:
    'Read a text file and return it with 1-based line numbers. Accepts a path relative to the ' +
    'workspace or an absolute path anywhere on the machine — the user is asked to approve the ' +
    'first access to a location outside the workspace. Use offset/limit for large files. ' +
    'Always read a file before editing it.',
  parameters: objectSchema(
    {
      path: string('Relative path inside the workspace, or an absolute path on this machine.'),
      offset: number('1-based line to start from. Defaults to 1.'),
      limit: number('Maximum number of lines to return. Defaults to 2000.')
    },
    ['path']
  ),
  readOnly: true,
  title: (input) => `Read(${input.path})`,

  async run(input, ctx) {
    const absolute = await resolveTarget(ctx, input.path, 'read')
    const stat = await fs.stat(absolute).catch(() => null)

    if (!stat) throw new ToolError(`File not found: ${input.path}`)
    if (stat.isDirectory())
      throw new ToolError(`${input.path} is a directory. Use list_dir instead.`)
    if (stat.size > MAX_READ_BYTES) {
      throw new ToolError(
        `File is ${(stat.size / 1e6).toFixed(1)} MB, too large to read whole. Use offset and limit.`
      )
    }

    const raw = await fs.readFile(absolute)
    if (isBinary(raw)) {
      throw new ToolError(`${input.path} looks like a binary file and cannot be read as text.`)
    }

    const allLines = raw.toString('utf8').split('\n')
    const offset = Math.max(1, input.offset ?? 1)
    const limit = Math.max(1, input.limit ?? 2000)
    const slice = allLines.slice(offset - 1, offset - 1 + limit)

    if (slice.length === 0) {
      throw new ToolError(
        `Offset ${offset} is past the end of ${input.path}, which has ${allLines.length} lines.`
      )
    }

    const numbered = slice
      .map((line, index) => `${String(offset + index).padStart(6)}\t${line}`)
      .join('\n')

    const shownEnd = offset - 1 + slice.length
    const more =
      shownEnd < allLines.length
        ? `\n\n(showing lines ${offset}-${shownEnd} of ${allLines.length})`
        : ''

    return {
      content: truncate(numbered) + more,
      display: {
        kind: 'text',
        summary: `Read ${slice.length} line${slice.length === 1 ? '' : 's'}`,
        body: slice.join('\n')
      }
    }
  }
}

interface WriteInput {
  path: string
  content: string
}

export const writeFileTool: ToolDef<WriteInput> = {
  name: 'write_file',
  description:
    'Create a new file or overwrite an existing one. For changes to an existing file prefer ' +
    'edit_file, which is safer and produces a smaller diff.',
  parameters: objectSchema(
    {
      path: string('Relative path inside the workspace, or an absolute path on this machine.'),
      content: string('Full file content to write.')
    },
    ['path', 'content']
  ),
  readOnly: false,
  title: (input) => `Write(${input.path})`,

  async run(input, ctx) {
    const absolute = await resolveTarget(ctx, input.path, 'write')
    const before = await fs.readFile(absolute, 'utf8').catch(() => null)
    const after = input.content ?? ''
    const shown = displayPath(ctx.cwd, absolute)

    const diff = before === null ? previewNewFile(after) : renderDiff(before, after)
    if (before !== null && before === after) {
      return unchanged(shown)
    }

    await gate(ctx, {
      toolName: 'write_file',
      kind: before === null ? 'write' : 'edit',
      title: `${before === null ? 'Create' : 'Overwrite'} ${shown}`,
      detail: diff || '(no textual change)',
      suggestedRule: writeRuleFor(ctx, absolute)
    })

    // Before the write, so a turn can be put back however it was approved.
    await ctx.captureBefore(absolute)
    await fs.mkdir(path.dirname(absolute), { recursive: true })
    await fs.writeFile(absolute, after, 'utf8')
    ctx.notifyFileChanged(absolute)
    stage(ctx, absolute, shown, before, after)

    const lines = after.split('\n').length
    return {
      content: `${before === null ? 'Created' : 'Overwrote'} ${shown} (${lines} lines).`,
      display: {
        kind: 'diff',
        summary: `${before === null ? 'Created' : 'Updated'} ${shown} · ${lines} lines`,
        diff
      }
    }
  }
}

interface EditInput {
  path: string
  old_string: string
  new_string: string
  replace_all?: boolean
}

export const editFileTool: ToolDef<EditInput> = {
  name: 'edit_file',
  description:
    'Replace an exact string in a file. `old_string` must match the file byte for byte, ' +
    'including indentation, and must be unique unless replace_all is true. ' +
    'Read the file first so the match is exact.',
  parameters: objectSchema(
    {
      path: string('Relative path inside the workspace, or an absolute path on this machine.'),
      old_string: string('Exact text to replace. Include surrounding lines to make it unique.'),
      new_string: string('Replacement text.'),
      replace_all: boolean('Replace every occurrence instead of requiring a unique match.')
    },
    ['path', 'old_string', 'new_string']
  ),
  readOnly: false,
  title: (input) => `Edit(${input.path})`,

  async run(input, ctx) {
    const absolute = await resolveTarget(ctx, input.path, 'write')
    const before = await fs.readFile(absolute, 'utf8').catch(() => null)
    if (before === null) throw new ToolError(`File not found: ${input.path}`)

    if (input.old_string === input.new_string) {
      throw new ToolError('old_string and new_string are identical — nothing to do.')
    }

    const occurrences = countOccurrences(before, input.old_string)
    if (occurrences === 0) {
      throw new ToolError(
        `old_string was not found in ${input.path}. Read the file again — whitespace and ` +
          'indentation must match exactly.'
      )
    }
    if (occurrences > 1 && !input.replace_all) {
      throw new ToolError(
        `old_string appears ${occurrences} times in ${input.path}. Add surrounding context to ` +
          'make it unique, or set replace_all.'
      )
    }

    const after = input.replace_all
      ? before.split(input.old_string).join(input.new_string)
      : before.replace(input.old_string, input.new_string)

    const shown = displayPath(ctx.cwd, absolute)
    const diff = renderDiff(before, after)
    const { added, removed } = countChanges(before, after)

    await gate(ctx, {
      toolName: 'edit_file',
      kind: 'edit',
      title: `Edit ${shown}`,
      detail: diff,
      suggestedRule: `Edit(${shown})`
    })

    await ctx.captureBefore(absolute)
    await fs.writeFile(absolute, after, 'utf8')
    ctx.notifyFileChanged(absolute)
    stage(ctx, absolute, shown, before, after)

    return {
      content: `Edited ${shown}: +${added} -${removed}${occurrences > 1 ? ` (${occurrences} occurrences)` : ''}.`,
      display: { kind: 'diff', summary: `${shown} · +${added} -${removed}`, diff }
    }
  }
}

interface DeleteInput {
  path: string
}

export const deleteFileTool: ToolDef<DeleteInput> = {
  name: 'delete_file',
  description: 'Delete a file. Deleting directories is not supported — use run_command for that.',
  parameters: objectSchema({ path: string('Path of the file to delete.') }, ['path']),
  readOnly: false,
  title: (input) => `Delete(${input.path})`,

  async run(input, ctx) {
    const absolute = await resolveTarget(ctx, input.path, 'write')
    const stat = await fs.stat(absolute).catch(() => null)
    if (!stat) throw new ToolError(`File not found: ${input.path}`)
    if (stat.isDirectory()) {
      throw new ToolError(`${input.path} is a directory. Use run_command to remove directories.`)
    }

    const before = await fs.readFile(absolute, 'utf8').catch(() => '')
    const shown = displayPath(ctx.cwd, absolute)

    // Deletion always prompts: it is the one edit "reject" cannot fully undo
    // for binary content, and it is rarely what the user expected.
    const approved = await ctx.requestPermission({
      toolName: 'delete_file',
      kind: 'edit',
      // What makes the comment above true. Without it, "apply edits without
      // asking" silently covered deletions as well.
      destructive: true,
      title: `Delete ${shown}`,
      detail: before
        .split('\n')
        .slice(0, 40)
        .map((line) => `-${line}`)
        .join('\n'),
      suggestedRule: `Delete(${shown})`
    })
    if (!approved) throw new ToolError('User rejected the deletion.')

    await ctx.captureBefore(absolute)
    await fs.rm(absolute)
    // Recorded so the deletion can be undone from the review screen like any
    // other edit. Without this it was the one change with no way back.
    ctx.changes.record({
      absolutePath: absolute,
      displayPath: shown,
      before,
      after: '',
      deleted: true
    })
    ctx.notifyFileChanged(absolute)

    return {
      content: `Deleted ${shown}.`,
      display: { kind: 'text', summary: `Deleted ${shown}` }
    }
  }
}

interface ListInput {
  path?: string
  depth?: number
}

const IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'out',
  '.next',
  '.venv',
  'venv',
  '__pycache__',
  'target',
  '.cache'
])

export const listDirTool: ToolDef<ListInput> = {
  name: 'list_dir',
  description:
    'List files and directories as a tree. Skips node_modules, .git, build output and similar ' +
    'noise. Accepts absolute paths for locations outside the workspace.',
  parameters: objectSchema(
    {
      path: string('Directory to list. Defaults to the workspace root.'),
      depth: number('How many levels to descend. Defaults to 2, max 5.')
    },
    []
  ),
  readOnly: true,
  title: (input) => `List(${input.path || '.'})`,

  async run(input, ctx) {
    const absolute = await resolveTarget(ctx, input.path || '.', 'read')
    const depth = Math.min(Math.max(input.depth ?? 2, 1), 5)
    const lines: string[] = []
    let count = 0

    const walk = async (dir: string, level: number, prefix: string): Promise<void> => {
      if (level > depth || count > 800 || ctx.signal.aborted) return
      const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => [])
      const sorted = entries
        .filter((entry) => !entry.name.startsWith('.') || entry.name === '.env.example')
        .filter((entry) => !IGNORED_DIRS.has(entry.name))
        .sort(
          (a, b) =>
            Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name)
        )

      for (const entry of sorted) {
        if (count++ > 800) return
        lines.push(`${prefix}${entry.name}${entry.isDirectory() ? '/' : ''}`)
        if (entry.isDirectory()) await walk(path.join(dir, entry.name), level + 1, `${prefix}  `)
      }
    }

    await walk(absolute, 1, '')
    const body = lines.join('\n') || '(empty)'

    return {
      content: truncate(`${displayPath(ctx.cwd, absolute)}/\n${body}`, 15_000),
      display: { kind: 'list', summary: `${lines.length} entries`, body }
    }
  }
}

/* ------------------------------------------------------------------ */
/* Shared helpers                                                      */
/* ------------------------------------------------------------------ */

/**
 * Applies the edit-approval policy: `ask` opens the dialog, `review` and
 * `auto` let the write through (review collects it for the review screen).
 */
async function gate(
  ctx: ToolContext,
  request: Parameters<ToolContext['requestPermission']>[0]
): Promise<void> {
  if (ctx.editApproval !== 'ask') return
  const approved = await ctx.requestPermission(request)
  if (!approved) throw new ToolError('User rejected the change.')
}

function stage(
  ctx: ToolContext,
  absolutePath: string,
  shown: string,
  before: string | null,
  after: string
): void {
  // In `ask` mode the user has already seen and approved each diff, so piling
  // them into the review screen would just be noise.
  if (ctx.editApproval === 'ask') return
  ctx.changes.record({ absolutePath, displayPath: shown, before, after })
}

function unchanged(shown: string): ToolOutcome {
  return {
    content: `${shown} already had exactly this content — nothing was written.`,
    display: { kind: 'text', summary: 'No change' }
  }
}

function previewNewFile(content: string): string {
  const lines = content.split('\n')
  const head = lines.slice(0, 60).map((line) => `+${line}`)
  if (lines.length > 60) head.push(`⋮ ${lines.length - 60} more lines`)
  return head.join('\n')
}

/** `Write(src/**)` for a nested file, `Write(*)` for one at the workspace root. */
function writeRuleFor(ctx: ToolContext, absolute: string): string {
  if (!isInside(ctx.cwd, absolute)) return `Write(${absolute})`
  const dir = path.posix.dirname(displayPath(ctx.cwd, absolute))
  return dir === '.' || dir === '' ? 'Write(*)' : `Write(${dir}/**)`
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0
  let count = 0
  let index = haystack.indexOf(needle)
  while (index !== -1) {
    count++
    index = haystack.indexOf(needle, index + needle.length)
  }
  return count
}

function isBinary(buffer: Buffer): boolean {
  return buffer.subarray(0, 8000).includes(0)
}
