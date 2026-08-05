/**
 * When a scheduled task should next run.
 *
 * Deliberately not cron. Cron expressions are unreadable to most people and
 * carry semantics nobody wants here (step values, ranges, day-of-month vs
 * day-of-week ambiguity). Four shapes cover what a task in an IDE actually
 * needs, and each one can be rendered back into a sentence.
 *
 * Everything here is pure and works in local time, so it can be tested without
 * a clock, a timezone, or Electron.
 */

export type Schedule =
  /** Every N minutes, measured from the last run. */
  | { kind: 'interval'; everyMinutes: number }
  /** Once a day at a local wall-clock time. */
  | { kind: 'daily'; atMinutes: number }
  /** On chosen weekdays at a local wall-clock time. 0 = Sunday. */
  | { kind: 'weekly'; days: number[]; atMinutes: number }
  /** A single run at an absolute moment. */
  | { kind: 'once'; atEpochMs: number }

export interface NextRunInput {
  /** Now, as epoch ms. Passed in rather than read so this stays testable. */
  from: number
  /** When this task last completed, if ever. */
  lastRunAt?: number
}

const MINUTE = 60_000
const DAY_MINUTES = 24 * 60
export const MIN_INTERVAL_MINUTES = 1
/** A week is the longest horizon any schedule here can need. */
const SEARCH_DAYS = 8

/**
 * The next moment this schedule fires, or null if it never will again.
 *
 * A task whose time passed while the app was closed returns `from` — it fires
 * once, immediately. The alternative, replaying every missed slot, turns a
 * laptop lid opening into a burst of API calls, which is never what was meant
 * by "every hour".
 */
export function nextRun(schedule: Schedule, input: NextRunInput): number | null {
  const { from, lastRunAt } = input

  switch (schedule.kind) {
    case 'interval': {
      const every = Math.max(MIN_INTERVAL_MINUTES, Math.floor(schedule.everyMinutes)) * MINUTE
      // With no previous run the clock starts now, so a task created at 10:00
      // that runs hourly first fires at 11:00 rather than the instant it is saved.
      const anchor = lastRunAt ?? from
      return Math.max(anchor + every, from)
    }

    case 'daily': {
      const at = clampMinutes(schedule.atMinutes)
      const today = atLocalMinutes(from, at)
      if (today > from) return today

      // addLocalDays, not `from + 24h`: on the two DST weekends a day is 23 or
      // 25 hours long, and adding a fixed 24 hours lands an hour either side of
      // the intended wall-clock time — which can produce a stamp that is not
      // strictly after `from`, and every caller relies on it being so.
      return atLocalMinutes(addLocalDays(from, 1), at)
    }

    case 'weekly': {
      const at = clampMinutes(schedule.atMinutes)
      const days = normaliseDays(schedule.days)
      if (days.length === 0) return null

      for (let offset = 0; offset < SEARCH_DAYS; offset++) {
        // Stepping by whole days through Date keeps this correct across a DST
        // boundary, where a day is not always 24 hours long.
        const candidate = atLocalMinutes(addLocalDays(from, offset), at)
        if (candidate > from && days.includes(new Date(candidate).getDay())) return candidate
      }
      return null
    }

    case 'once':
      if (schedule.atEpochMs > from) return schedule.atEpochMs
      // Missed while the app was closed. The same collapse rule as an interval
      // applies: run it once now rather than dropping it silently, which is
      // what "run this at 9am" meant. Once it has run, it is done for good.
      return lastRunAt === undefined ? from : null
  }
}

/** A one-line description, e.g. "Every 2 hours" or "Mon, Fri at 09:30". */
export function describeSchedule(schedule: Schedule): string {
  switch (schedule.kind) {
    case 'interval':
      return `Every ${formatDuration(Math.max(MIN_INTERVAL_MINUTES, schedule.everyMinutes))}`
    case 'daily':
      return `Daily at ${formatClock(schedule.atMinutes)}`
    case 'weekly': {
      const days = normaliseDays(schedule.days)
      if (days.length === 0) return 'No days chosen'
      if (days.length === 7) return `Daily at ${formatClock(schedule.atMinutes)}`
      return `${days.map((day) => DAY_NAMES[day]).join(', ')} at ${formatClock(schedule.atMinutes)}`
    }
    case 'once':
      return `Once at ${new Date(schedule.atEpochMs).toLocaleString()}`
  }
}

/** Rejects schedules that would misfire, so bad input never reaches a timer. */
export function validateSchedule(schedule: Schedule): string | null {
  switch (schedule.kind) {
    case 'interval':
      if (!Number.isFinite(schedule.everyMinutes) || schedule.everyMinutes < MIN_INTERVAL_MINUTES) {
        return `Interval must be at least ${MIN_INTERVAL_MINUTES} minute.`
      }
      return null
    case 'daily':
      return validMinutes(schedule.atMinutes) ? null : 'Time of day is out of range.'
    case 'weekly':
      if (normaliseDays(schedule.days).length === 0) return 'Pick at least one day.'
      return validMinutes(schedule.atMinutes) ? null : 'Time of day is out of range.'
    case 'once':
      return Number.isFinite(schedule.atEpochMs) ? null : 'Pick a date and time.'
  }
}

/** Formats minutes-since-midnight as HH:MM. */
export function formatClock(atMinutes: number): string {
  const total = clampMinutes(atMinutes)
  const hours = Math.floor(total / 60)
  return `${pad(hours)}:${pad(total % 60)}`
}

/** Parses "09:30" back into minutes since midnight; null if unparseable. */
export function parseClock(value: string): number | null {
  const match = /^\s*(\d{1,2})\s*:\s*(\d{2})\s*$/.exec(value)
  if (!match) return null

  const hours = Number(match[1])
  const minutes = Number(match[2])
  if (hours > 23 || minutes > 59) return null
  return hours * 60 + minutes
}

export const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

/* ------------------------------------------------------------------ */

function formatDuration(minutes: number): string {
  const whole = Math.floor(minutes)
  if (whole < 60) return `${whole} min`
  if (whole % 60 === 0) {
    const hours = whole / 60
    if (hours % 24 === 0 && hours >= 24) {
      const days = hours / 24
      return days === 1 ? 'day' : `${days} days`
    }
    return hours === 1 ? 'hour' : `${hours} hours`
  }
  return `${Math.floor(whole / 60)}h ${whole % 60}m`
}

/** The given wall-clock time on the local day that `at` falls on. */
function atLocalMinutes(at: number, minutes: number): number {
  const date = new Date(at)
  date.setHours(Math.floor(minutes / 60), minutes % 60, 0, 0)
  return date.getTime()
}

/**
 * Adds whole local days.
 *
 * Adding 24 hours of milliseconds is wrong twice a year: on a DST boundary the
 * result lands an hour either side of the same wall-clock time, which is enough
 * to make a daily 09:00 task drift into 08:00 and eventually skip a day.
 */
function addLocalDays(at: number, days: number): number {
  const date = new Date(at)
  date.setDate(date.getDate() + days)
  return date.getTime()
}

function normaliseDays(days: number[]): number[] {
  return [...new Set(days.filter((day) => Number.isInteger(day) && day >= 0 && day <= 6))].sort(
    (a, b) => a - b
  )
}

function validMinutes(minutes: number): boolean {
  return Number.isFinite(minutes) && minutes >= 0 && minutes < DAY_MINUTES
}

function clampMinutes(minutes: number): number {
  if (!Number.isFinite(minutes)) return 0
  return Math.min(DAY_MINUTES - 1, Math.max(0, Math.floor(minutes)))
}

function pad(value: number): string {
  return String(value).padStart(2, '0')
}
