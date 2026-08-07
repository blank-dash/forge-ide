import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { FileEntry } from '@shared/types'

const HIDDEN = new Set([
  'node_modules',
  '.git',
  '.svn',
  '.hg',
  'dist',
  'build',
  'out',
  '.next',
  '.turbo',
  '.cache',
  '__pycache__',
  '.venv',
  'venv',
  'target',
  '.DS_Store'
])

export class Workspace {
  private root: string
  /** True once someone opened a folder deliberately (CLI argument or dialog). */
  private chosen = false

  constructor(initial?: string) {
    this.root = initial ?? process.cwd() ?? os.homedir()
  }

  get cwd(): string {
    return this.root
  }

  get isExplicit(): boolean {
    return this.chosen
  }

  get name(): string {
    return path.basename(this.root) || this.root
  }

  async open(next: string): Promise<string> {
    const stat = await fs.stat(next).catch(() => null)
    if (!stat?.isDirectory()) throw new Error(`Not a directory: ${next}`)
    this.root = path.resolve(next)
    this.chosen = true
    return this.root
  }

  /** One directory level; the tree lazily loads children as the user expands. */
  async list(relative: string): Promise<FileEntry[]> {
    const target = this.resolve(relative)
    const entries = await fs.readdir(target, { withFileTypes: true }).catch((error) => {
      console.warn('[workspace] list failed', target, error)
      return []
    })

    const mapped = await Promise.all(
      entries
        .filter((entry) => !HIDDEN.has(entry.name))
        .map(async (entry) => {
          const absolute = path.join(target, entry.name)
          const stat = entry.isFile() ? await fs.stat(absolute).catch(() => null) : null
          return {
            name: entry.name,
            path: this.relative(absolute),
            isDirectory: entry.isDirectory(),
            size: stat?.size ?? 0
          } satisfies FileEntry
        })
    )

    return mapped.sort(
      (a, b) =>
        Number(b.isDirectory) - Number(a.isDirectory) ||
        a.name.localeCompare(b.name, undefined, { numeric: true })
    )
  }

  async readFile(relative: string): Promise<string> {
    const absolute = this.resolve(relative)
    const stat = await fs.stat(absolute)
    if (stat.size > 8_000_000) throw new Error('File is too large to open in the editor.')
    const raw = await fs.readFile(absolute)
    if (raw.subarray(0, 8000).includes(0)) throw new Error('Binary file.')
    return raw.toString('utf8')
  }

  async writeFile(relative: string, content: string): Promise<void> {
    const absolute = this.resolve(relative)
    await fs.mkdir(path.dirname(absolute), { recursive: true })
    await fs.writeFile(absolute, content, 'utf8')
  }

  resolve(relative: string): string {
    const absolute = path.isAbsolute(relative)
      ? path.normalize(relative)
      : path.resolve(this.root, relative || '.')
    const rel = path.relative(this.root, absolute)
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new Error(`Path escapes the workspace: ${relative}`)
    }
    return absolute
  }

  relative(absolute: string): string {
    const rel = path.relative(this.root, absolute)
    return rel === '' ? '.' : rel.split(path.sep).join('/')
  }
}
