import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { PendingChange } from '@shared/types'
import { countChanges, renderDiff } from './diff'

export interface RecordInput {
  absolutePath: string
  displayPath: string
  /** File content before this edit; null when the file did not exist. */
  before: string | null
  after: string
}

/**
 * Tracks every file the agent has written since the last accept/reject so the
 * review screen can show one diff per file and roll individual files back.
 *
 * The snapshot kept is the content from *before the first* change to a file,
 * so repeated edits to the same file still review as a single coherent diff.
 */
export class ChangeTracker {
  private changes = new Map<string, PendingChange>()
  private listeners = new Set<(changes: PendingChange[]) => void>()

  onChange(listener: (changes: PendingChange[]) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  list(): PendingChange[] {
    return [...this.changes.values()].sort((a, b) => b.updatedAt - a.updatedAt)
  }

  get count(): number {
    return this.changes.size
  }

  has(absolutePath: string): boolean {
    return this.changes.has(key(absolutePath))
  }

  record(input: RecordInput): PendingChange {
    const id = key(input.absolutePath)
    const existing = this.changes.get(id)

    // Keep the oldest snapshot: it is what "reject" must restore.
    const before = existing ? existing.before : input.before
    const diff =
      before === null
        ? input.after
            .split('\n')
            .map((line) => `+${line}`)
            .join('\n')
        : renderDiff(before, input.after)
    const counts =
      before === null
        ? { added: input.after.split('\n').length, removed: 0 }
        : countChanges(before, input.after)

    const change: PendingChange = {
      id: existing?.id ?? randomUUID(),
      path: input.displayPath,
      absolutePath: input.absolutePath,
      kind: before === null ? 'create' : 'modify',
      before,
      after: input.after,
      diff,
      added: counts.added,
      removed: counts.removed,
      updatedAt: Date.now()
    }

    this.changes.set(id, change)
    this.emit()
    return change
  }

  accept(id: string): void {
    for (const [mapKey, change] of this.changes) {
      if (change.id === id) {
        this.changes.delete(mapKey)
        break
      }
    }
    this.emit()
  }

  acceptAll(): void {
    this.changes.clear()
    this.emit()
  }

  /** Restores the file to its pre-change state and drops the record. */
  async reject(id: string): Promise<void> {
    const entry = [...this.changes.entries()].find(([, change]) => change.id === id)
    if (!entry) return

    const [mapKey, change] = entry
    await restore(change)
    this.changes.delete(mapKey)
    this.emit()
  }

  async rejectAll(): Promise<void> {
    const all = [...this.changes.values()]
    // Sequential on purpose: parallel writes to the same tree have surprised
    // us before, and this list is short by construction.
    for (const change of all) await restore(change)
    this.changes.clear()
    this.emit()
  }

  clear(): void {
    this.changes.clear()
    this.emit()
  }

  private emit(): void {
    const snapshot = this.list()
    for (const listener of this.listeners) listener(snapshot)
  }
}

async function restore(change: PendingChange): Promise<void> {
  if (change.before === null) {
    await fs.rm(change.absolutePath, { force: true })
    return
  }
  await fs.mkdir(path.dirname(change.absolutePath), { recursive: true })
  await fs.writeFile(change.absolutePath, change.before, 'utf8')
}

function key(absolutePath: string): string {
  // Windows paths are case-insensitive; without this the same file can be
  // tracked twice under different casings.
  return process.platform === 'win32' ? absolutePath.toLowerCase() : absolutePath
}
