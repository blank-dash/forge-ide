import { promises as fs } from 'node:fs'
import path from 'node:path'
import fg from 'fast-glob'
import {
  boolean,
  displayPath,
  number,
  objectSchema,
  resolveTarget,
  string,
  ToolError,
  truncate,
  type ToolDef
} from './types'

const DEFAULT_IGNORE = [
  '**/node_modules/**',
  '**/.git/**',
  '**/dist/**',
  '**/build/**',
  '**/out/**',
  '**/.next/**',
  '**/coverage/**',
  '**/__pycache__/**',
  '**/.venv/**',
  '**/venv/**',
  '**/target/**',
  '**/*.lock',
  '**/*.min.js',
  '**/*.map'
]

interface GlobInput {
  pattern: string
  path?: string
  limit?: number
}

export const globTool: ToolDef<GlobInput> = {
  name: 'glob',
  description:
    'Find files by glob pattern (e.g. "src/**/*.ts", "**/*.test.tsx"). ' +
    'Returns paths sorted by last modified, newest first. Use this to locate files by name.',
  parameters: objectSchema(
    {
      pattern: string('Glob pattern, e.g. "src/**/*.ts".'),
      path: string('Directory to search in, relative to the workspace root.'),
      limit: number('Maximum number of results. Defaults to 200.')
    },
    ['pattern']
  ),
  readOnly: true,
  title: (input) => `Glob(${input.pattern})`,

  async run(input, ctx) {
    const root = await resolveTarget(ctx, input.path || '.', 'read')
    const limit = Math.min(input.limit ?? 200, 1000)

    const matches = await fg(input.pattern, {
      cwd: root,
      ignore: DEFAULT_IGNORE,
      dot: false,
      onlyFiles: true,
      absolute: true,
      suppressErrors: true,
      followSymbolicLinks: false
    })

    const withTimes = await Promise.all(
      matches.slice(0, 5000).map(async (file) => ({
        file,
        mtime: await fs
          .stat(file)
          .then((stat) => stat.mtimeMs)
          .catch(() => 0)
      }))
    )

    const sorted = withTimes
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, limit)
      .map((entry) => displayPath(ctx.cwd, entry.file))

    const body = sorted.join('\n') || 'No files matched.'
    return {
      content: truncate(body, 15_000),
      display: {
        kind: 'list',
        summary: `${sorted.length} file${sorted.length === 1 ? '' : 's'}${matches.length > sorted.length ? ` (of ${matches.length})` : ''}`,
        body
      }
    }
  }
}

interface GrepInput {
  pattern: string
  path?: string
  glob?: string
  case_insensitive?: boolean
  context?: number
  limit?: number
}

const MAX_SCAN_BYTES = 1_500_000

export const grepTool: ToolDef<GrepInput> = {
  name: 'grep',
  description:
    'Search file contents with a JavaScript regular expression. ' +
    'Returns matching lines as `path:line: text`. Narrow the search with `glob` when possible.',
  parameters: objectSchema(
    {
      pattern: string('JavaScript regular expression, e.g. "function\\\\s+\\\\w+".'),
      path: string('Directory to search in, relative to the workspace root.'),
      glob: string('Restrict to files matching this glob, e.g. "**/*.ts".'),
      case_insensitive: boolean('Case-insensitive match.'),
      context: number('Lines of context to include around each match. Defaults to 0.'),
      limit: number('Maximum number of matching lines. Defaults to 200.')
    },
    ['pattern']
  ),
  readOnly: true,
  title: (input) => `Grep(${input.pattern})`,

  async run(input, ctx) {
    const root = await resolveTarget(ctx, input.path || '.', 'read')
    const limit = Math.min(input.limit ?? 200, 1000)
    const contextLines = Math.min(Math.max(input.context ?? 0, 0), 5)

    let regex: RegExp
    try {
      regex = new RegExp(input.pattern, input.case_insensitive ? 'i' : '')
    } catch (error) {
      throw new ToolError(`Invalid regular expression: ${(error as Error).message}`)
    }

    const files = await fg(input.glob || '**/*', {
      cwd: root,
      ignore: DEFAULT_IGNORE,
      onlyFiles: true,
      absolute: true,
      dot: false,
      suppressErrors: true,
      followSymbolicLinks: false
    })

    const results: string[] = []
    let matchedFiles = 0

    for (const file of files) {
      if (ctx.signal.aborted) break
      if (results.length >= limit) break

      const stat = await fs.stat(file).catch(() => null)
      if (!stat || stat.size > MAX_SCAN_BYTES) continue

      const raw = await fs.readFile(file).catch(() => null)
      if (!raw || raw.includes(0)) continue

      const lines = raw.toString('utf8').split('\n')
      let fileMatched = false

      for (let i = 0; i < lines.length && results.length < limit; i++) {
        if (!regex.test(lines[i])) continue
        fileMatched = true

        const rel = displayPath(ctx.cwd, file)
        const from = Math.max(0, i - contextLines)
        const to = Math.min(lines.length - 1, i + contextLines)

        for (let j = from; j <= to; j++) {
          const marker = j === i ? ':' : '-'
          results.push(`${rel}:${j + 1}${marker} ${lines[j].slice(0, 400)}`)
        }
      }

      if (fileMatched) matchedFiles++
    }

    const body = results.join('\n') || 'No matches.'
    return {
      content: truncate(body, 25_000),
      display: {
        kind: 'text',
        summary: `${results.length} line${results.length === 1 ? '' : 's'} in ${matchedFiles} file${matchedFiles === 1 ? '' : 's'}`,
        body
      }
    }
  }
}

/** Builds the compact project overview injected into the system prompt. */
export async function buildProjectSnapshot(cwd: string, maxFiles = 400): Promise<string> {
  const files = await fg('**/*', {
    cwd,
    ignore: DEFAULT_IGNORE,
    onlyFiles: true,
    dot: false,
    suppressErrors: true,
    followSymbolicLinks: false,
    deep: 6
  }).catch(() => [] as string[])

  const shown = files.slice(0, maxFiles).sort()
  const extra =
    files.length > shown.length ? `\n… and ${files.length - shown.length} more files` : ''
  return `${shown.map((file) => file.split(path.sep).join('/')).join('\n')}${extra}`
}
