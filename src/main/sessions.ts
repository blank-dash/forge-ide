import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import type { SessionRecord, SessionSummary } from '@shared/types'

const MAX_SESSIONS_PER_WORKSPACE = 100

/**
 * Session history lives in the app's user-data directory, bucketed by
 * workspace — never inside the user's repository, which they would then have
 * to gitignore.
 */
export class SessionStore {
  private writeQueue: Promise<unknown> = Promise.resolve()

  constructor(private readonly cwd: () => string) {}

  private get dir(): string {
    const hash = createHash('sha256').update(this.cwd()).digest('hex').slice(0, 16)
    return path.join(app.getPath('userData'), 'sessions', hash)
  }

  /**
   * Waits for any queued write to land.
   *
   * Saving is fire-and-forget so a turn never blocks on the disk, which means
   * a listing taken right after a turn ends can read the directory before the
   * file is there — and the conversation you just had is missing from history
   * until something else happens to refresh it.
   */
  async flush(): Promise<void> {
    await this.writeQueue.catch((error) => console.warn('[sessions] queued write failed', error))
  }

  async list(): Promise<SessionSummary[]> {
    await this.flush()
    const dir = this.dir
    const names = await fs.readdir(dir).catch((error) => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        console.warn('[sessions] list failed', dir, error)
      return [] as string[]
    })

    const summaries = await Promise.all(
      names
        .filter((name) => name.endsWith('.json'))
        .map(async (name) => {
          const raw = await fs.readFile(path.join(dir, name), 'utf8').catch((error) => {
            console.warn('[sessions] read failed', error)
            return null
          })
          if (!raw) return null
          try {
            const record = JSON.parse(raw) as SessionRecord
            return {
              id: record.id,
              title: record.title,
              updatedAt: record.updatedAt,
              messageCount: record.messages?.length ?? 0
            } satisfies SessionSummary
          } catch {
            return null
          }
        })
    )

    return summaries
      .filter((entry): entry is SessionSummary => entry !== null)
      .sort((a, b) => b.updatedAt - a.updatedAt)
  }

  async load(id: string): Promise<SessionRecord | null> {
    const raw = await fs
      .readFile(path.join(this.dir, `${safeId(id)}.json`), 'utf8')
      .catch((error) => {
        console.warn('[sessions] read failed', error)
        return null
      })
    if (!raw) return null
    try {
      return JSON.parse(raw) as SessionRecord
    } catch {
      return null
    }
  }

  /** Writes are serialised and never rejected — losing history must not break a turn. */
  save(record: SessionRecord): Promise<void> {
    this.writeQueue = this.writeQueue
      .then(async () => {
        if (record.messages.length === 0) return
        const dir = this.dir
        await fs.mkdir(dir, { recursive: true })
        await fs.writeFile(
          path.join(dir, `${safeId(record.id)}.json`),
          JSON.stringify(record),
          'utf8'
        )
        await this.prune(dir)
      })
      .catch((error) => console.warn('[sessions] save failed', record.id, error))

    return this.writeQueue as Promise<void>
  }

  async remove(id: string): Promise<void> {
    await fs.rm(path.join(this.dir, `${safeId(id)}.json`), { force: true }).catch(() => undefined)
  }

  private async prune(dir: string): Promise<void> {
    const names = (await fs.readdir(dir).catch(() => [])).filter((name) => name.endsWith('.json'))
    if (names.length <= MAX_SESSIONS_PER_WORKSPACE) return

    const stats = await Promise.all(
      names.map(async (name) => ({
        name,
        mtime: await fs
          .stat(path.join(dir, name))
          .then((stat) => stat.mtimeMs)
          .catch(() => 0)
      }))
    )

    const oldest = stats
      .sort((a, b) => a.mtime - b.mtime)
      .slice(0, names.length - MAX_SESSIONS_PER_WORKSPACE)
    await Promise.all(oldest.map((entry) => fs.rm(path.join(dir, entry.name), { force: true })))
  }
}

function safeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, '')
}
