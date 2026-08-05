import { promises as fs } from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import type { TokenUsage } from '@shared/types'

/**
 * What this has cost, by day.
 *
 * The status bar shows the current conversation and nothing else, which answers
 * "what did that reply cost" but never "am I spending more than I think". A
 * day is the right grain: fine enough to spot the day something ran away, coarse
 * enough that a year of it is a small file.
 *
 * Written once a minute at most rather than on every turn — this is a
 * curiosity, not an audit log, and it must never be the reason a turn waits.
 */

export interface UsageDay {
  /** Local date, YYYY-MM-DD. */
  date: string
  input: number
  output: number
  cacheRead: number
  reasoning: number
  costUsd: number
  turns: number
}

const FLUSH_MS = 60_000
const KEEP_DAYS = 400

export class UsageLog {
  private days = new Map<string, UsageDay>()
  private loaded = false
  private dirty = false
  private timer: ReturnType<typeof setTimeout> | null = null

  private get file(): string {
    return path.join(app.getPath('userData'), 'usage.json')
  }

  async read(): Promise<UsageDay[]> {
    await this.load()
    return [...this.days.values()].sort((a, b) => (a.date < b.date ? 1 : -1))
  }

  async add(usage: TokenUsage): Promise<void> {
    if (!usage.input && !usage.output) return
    await this.load()

    const date = today()
    const day = this.days.get(date) ?? {
      date,
      input: 0,
      output: 0,
      cacheRead: 0,
      reasoning: 0,
      costUsd: 0,
      turns: 0
    }

    day.input += usage.input
    day.output += usage.output
    day.cacheRead += usage.cacheRead
    day.reasoning += usage.reasoning
    day.costUsd += usage.costUsd
    day.turns += 1

    this.days.set(date, day)
    this.dirty = true
    this.schedule()
  }

  /** Writes anything pending. Called on quit. */
  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (!this.dirty) return
    this.dirty = false

    const all = [...this.days.values()].sort((a, b) => (a.date < b.date ? 1 : -1)).slice(0, KEEP_DAYS)
    await fs.writeFile(this.file, JSON.stringify(all), 'utf8').catch(() => undefined)
  }

  private schedule(): void {
    if (this.timer) return
    this.timer = setTimeout(() => {
      this.timer = null
      void this.flush()
    }, FLUSH_MS)
    this.timer.unref?.()
  }

  private async load(): Promise<void> {
    if (this.loaded) return
    this.loaded = true

    const raw = await fs.readFile(this.file, 'utf8').catch(() => null)
    if (!raw) return

    try {
      for (const day of JSON.parse(raw) as UsageDay[]) {
        if (day?.date) this.days.set(day.date, day)
      }
    } catch {
      // A corrupt file costs a history, not a session.
    }
  }
}

/** Local date, not UTC: "today" should mean the user's today. */
function today(): string {
  const now = new Date()
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}
