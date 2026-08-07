import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { app } from 'electron'

/**
 * Undo for a whole turn.
 *
 * The review screen can reject one edit; this puts the workspace back to how it
 * was before the agent started. That is the thing you actually want after a turn
 * that touched nine files and got the shape wrong — and `git checkout` is not an
 * answer when the work you would lose is your own uncommitted work.
 *
 * Only files the agent actually wrote are stored, and only their previous
 * contents. Snapshotting the workspace would be both enormous and slower than
 * the turn it precedes.
 */

export interface Checkpoint {
  id: string
  sessionId: string
  /** What was asked, so the list reads as a history rather than as hashes. */
  label: string
  createdAt: number
  files: Array<{ path: string; existed: boolean }>
}

/** Beyond this a file is left out rather than copied on every edit. */
const MAX_FILE_BYTES = 4 * 1024 * 1024
/** Per workspace. Older ones are pruned; this is undo, not version control. */
const MAX_CHECKPOINTS = 40

export class CheckpointStore {
  /** Files captured for the turn currently in flight, keyed by session. */
  private pending = new Map<string, Map<string, { existed: boolean; before: string | null }>>()

  constructor(private readonly cwd: () => string) {}

  private get root(): string {
    const hash = createHash('sha256').update(this.cwd()).digest('hex').slice(0, 16)
    return path.join(app.getPath('userData'), 'checkpoints', hash)
  }

  /** Starts collecting for a turn. Any half-collected previous one is dropped. */
  begin(sessionId: string): void {
    this.pending.set(sessionId, new Map())
  }

  /**
   * Records a file's contents before the agent changes it.
   *
   * Called before the write, and only the first time in a turn — the point of
   * reference is how the file looked when the turn started, not after the third
   * edit of the same file.
   */
  async capture(sessionId: string, absolutePath: string): Promise<void> {
    const turn = this.pending.get(sessionId)
    if (!turn || turn.has(absolutePath)) return

    const stat = await fs.stat(absolutePath).catch((error) => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        console.warn('[checkpoint] stat failed', absolutePath, error)
      return null
    })
    if (stat && stat.size > MAX_FILE_BYTES) return

    const before = stat
      ? await fs.readFile(absolutePath, 'utf8').catch((error) => {
          console.warn('[checkpoint] read failed', absolutePath, error)
          return null
        })
      : null
    turn.set(absolutePath, { existed: stat !== null, before })
  }

  /**
   * Closes the turn and writes a checkpoint, if anything changed.
   *
   * Returns null when the turn touched nothing, which is most of them — a
   * conversation that only read files should not litter the list.
   */
  async commit(sessionId: string, label: string): Promise<Checkpoint | null> {
    const turn = this.pending.get(sessionId)
    this.pending.delete(sessionId)
    if (!turn || turn.size === 0) return null

    const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    const dir = path.join(this.root, id)
    await fs.mkdir(dir, { recursive: true })

    const files: Checkpoint['files'] = []
    let index = 0

    for (const [absolute, entry] of turn) {
      const name = `${index++}.bak`
      if (entry.existed && entry.before !== null) {
        await fs.writeFile(path.join(dir, name), entry.before, 'utf8').catch((error) => {
          console.warn('[checkpoint] backup write failed', path.join(dir, name), error)
        })
      }
      files.push({ path: absolute, existed: entry.existed })
    }

    const checkpoint: Checkpoint = {
      id,
      sessionId,
      label: label.trim().slice(0, 120) || 'Untitled turn',
      createdAt: Date.now(),
      files
    }

    await fs
      .writeFile(path.join(dir, 'meta.json'), JSON.stringify(checkpoint, null, 2), 'utf8')
      .catch((error) => {
        console.warn('[checkpoint] metadata write failed', id, error)
      })

    await this.prune()
    return checkpoint
  }

  /** Drops a turn's collection without writing anything, e.g. after an abort. */
  discard(sessionId: string): void {
    this.pending.delete(sessionId)
  }

  async list(): Promise<Checkpoint[]> {
    const names = await fs.readdir(this.root).catch((error) => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        console.warn('[checkpoint] list failed', error)
      return [] as string[]
    })

    const found = await Promise.all(
      names.map(async (name) => {
        const raw = await fs
          .readFile(path.join(this.root, name, 'meta.json'), 'utf8')
          .catch((error) => {
            console.warn('[checkpoint] metadata read failed', name, error)
            return null
          })
        if (!raw) return null
        try {
          return JSON.parse(raw) as Checkpoint
        } catch (error) {
          console.warn('[checkpoint] invalid metadata', name, error)
          return null
        }
      })
    )

    return found
      .filter((entry): entry is Checkpoint => entry !== null)
      .sort((a, b) => b.createdAt - a.createdAt)
  }

  /**
   * Puts every file in a checkpoint back.
   *
   * A file that did not exist before is deleted; one that did is rewritten.
   * Errors are collected rather than thrown, because a restore that stops at
   * the first missing directory leaves the workspace in a third state that was
   * never asked for.
   */
  async restore(id: string): Promise<{ restored: number; problems: string[] }> {
    const dir = path.join(this.root, id)
    const raw = await fs.readFile(path.join(dir, 'meta.json'), 'utf8').catch(() => null)
    if (!raw) throw new Error('That checkpoint is no longer on disk.')

    const checkpoint = JSON.parse(raw) as Checkpoint
    const problems: string[] = []
    let restored = 0

    for (const [index, file] of checkpoint.files.entries()) {
      try {
        if (!file.existed) {
          await fs.rm(file.path, { force: true })
          restored += 1
          continue
        }

        const backup = await fs.readFile(path.join(dir, `${index}.bak`), 'utf8')
        await fs.mkdir(path.dirname(file.path), { recursive: true })
        await fs.writeFile(file.path, backup, 'utf8')
        restored += 1
      } catch (error) {
        problems.push(`${file.path}: ${(error as Error).message}`)
      }
    }

    return { restored, problems }
  }

  async remove(id: string): Promise<void> {
    await fs.rm(path.join(this.root, id), { recursive: true, force: true }).catch((error) => {
      console.warn('[checkpoint] remove failed', id, error)
    })
  }

  private async prune(): Promise<void> {
    const all = await this.list()
    for (const old of all.slice(MAX_CHECKPOINTS)) await this.remove(old.id)
  }
}
