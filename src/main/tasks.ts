import { createHash, randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import { normaliseTask } from '@shared/tasks'
import type { ScheduledTask } from '@shared/types'
import { scheduleFrom } from './scheduler'

/**
 * Scheduled tasks, stored per workspace.
 *
 * A task runs against a particular folder, so it belongs to that folder rather
 * than to the app — the same reasoning that puts conversation history in a
 * per-workspace bucket, and the same directory, so both are discarded together.
 */
export class TaskStore {
  private cache: ScheduledTask[] | null = null
  private writeQueue: Promise<unknown> = Promise.resolve()
  /** Which workspace the cache belongs to, so a folder switch reloads. */
  private loadedFor = ''

  constructor(private readonly cwd: () => string) {}

  /**
   * Its own directory, deliberately not the session bucket.
   *
   * SessionStore owns `sessions/<hash>/`, lists every `*.json` in it as a
   * conversation, and prunes the oldest once there are more than a hundred. A
   * tasks.json living there would be parsed as a broken conversation and, on a
   * busy workspace, eventually deleted outright.
   */
  private get file(): string {
    const hash = createHash('sha256').update(this.cwd()).digest('hex').slice(0, 16)
    return path.join(app.getPath('userData'), 'tasks', `${hash}.json`)
  }

  /** The last loaded list, synchronously. The scheduler reads this on every tick. */
  all(): ScheduledTask[] {
    return this.cache ?? []
  }

  async load(): Promise<ScheduledTask[]> {
    const cwd = this.cwd()
    if (this.cache && this.loadedFor === cwd) return this.cache

    const raw = await fs.readFile(this.file, 'utf8').catch((error) => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        console.warn('[tasks] read failed', this.file, error)
      return null
    })
    this.loadedFor = cwd
    this.cache = raw ? this.parse(raw) : []
    return this.cache
  }

  async upsert(task: Partial<ScheduledTask>): Promise<ScheduledTask> {
    const tasks = await this.load()
    const saved = this.prepare({ ...task, id: task.id || randomUUID() })

    const index = tasks.findIndex((entry) => entry.id === saved.id)
    this.cache =
      index === -1 ? [...tasks, saved] : tasks.map((entry, i) => (i === index ? saved : entry))

    await this.flush()
    return saved
  }

  async remove(id: string): Promise<void> {
    const tasks = await this.load()
    this.cache = tasks.filter((task) => task.id !== id)
    await this.flush()
  }

  /**
   * Writes back the bookkeeping after a run.
   *
   * Unlike upsert this trusts the caller's `nextRunAt`: the scheduler has just
   * computed it from the moment the run finished, and recomputing from "now"
   * here would quietly shift it.
   */
  async record(task: ScheduledTask): Promise<void> {
    const tasks = await this.load()
    if (!tasks.some((entry) => entry.id === task.id)) return

    this.cache = tasks.map((entry) => (entry.id === task.id ? task : entry))
    await this.flush()
  }

  /** Drops the cache so the next read comes from the new workspace's file. */
  invalidate(): void {
    this.cache = null
    this.loadedFor = ''
  }

  /* ---------------------------------------------------------------- */

  /** Fills in identity and recomputes when this task should next fire. */
  private prepare(task: Partial<ScheduledTask>): ScheduledTask {
    const now = Date.now()
    const schedule = task.schedule ?? { kind: 'interval' as const, everyMinutes: 60 }
    return normaliseTask(task, now, scheduleFrom(schedule, now, task.lastRunAt))
  }

  private parse(raw: string): ScheduledTask[] {
    try {
      const parsed = JSON.parse(raw) as unknown
      if (!Array.isArray(parsed)) return []

      // Recomputed on load: a stamp written before the app was closed is stale,
      // and the schedule — not the stamp — is what the user actually asked for.
      return parsed
        .filter(
          (entry): entry is Partial<ScheduledTask> => typeof entry === 'object' && entry !== null
        )
        .map((entry) => this.prepare({ ...entry, id: entry.id || randomUUID() }))
    } catch {
      // A corrupt file must not take the app down with it; the user can rebuild
      // a task list far more easily than they can recover from a crash loop.
      return []
    }
  }

  /**
   * Serialised, atomic, and never rejecting: a scheduled run must not fail
   * because its bookkeeping could not be written.
   */
  private flush(): Promise<void> {
    const snapshot = this.cache ?? []
    const target = this.file

    this.writeQueue = this.writeQueue
      .then(async () => {
        await fs.mkdir(path.dirname(target), { recursive: true })
        const temporary = `${target}.tmp`
        await fs.writeFile(temporary, JSON.stringify(snapshot, null, 2), 'utf8')
        // Rename is atomic, so a crash mid-write cannot leave a half list.
        await fs.rename(temporary, target)
      })
      .catch((error: Error) => {
        console.error('[tasks] could not save', error)
      })

    return this.writeQueue as Promise<void>
  }
}
