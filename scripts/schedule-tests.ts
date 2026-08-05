/**
 * Tests for schedule arithmetic.
 *
 * All of it is local-time maths, which is where scheduling bugs live: the same
 * code that looks right in UTC drifts an hour twice a year, fires twice on the
 * boundary, or replays a week of missed runs the moment a laptop wakes up.
 *
 * Every case builds its dates with the local `Date` constructor, so the suite
 * gives the same answer in any timezone.
 */
import assert from 'node:assert/strict'
import {
  DAY_NAMES,
  describeSchedule,
  formatClock,
  nextRun,
  parseClock,
  validateSchedule,
  type Schedule
} from '../src/shared/schedule'

const MINUTE = 60_000
const HOUR = 60 * MINUTE

/**
 * Runs a case in a timezone that actually observes daylight saving.
 *
 * Without this the DST cases are vacuous on any machine set to a fixed-offset
 * zone — which is most of them, and was the case on the machine this was
 * written on: the assertions passed while testing nothing.
 */
function withTimezone(zone: string, body: () => void): void {
  const previous = process.env.TZ
  process.env.TZ = zone
  try {
    body()
  } finally {
    if (previous === undefined) delete process.env.TZ
    else process.env.TZ = previous
  }
}

/** Local wall-clock moment, independent of the machine's timezone. */
function local(
  year: number,
  month: number,
  day: number,
  hours = 0,
  minutes = 0
): number {
  return new Date(year, month - 1, day, hours, minutes, 0, 0).getTime()
}

export async function runScheduleTests(
  test: (name: string, fn: () => Promise<void> | void) => Promise<void>
): Promise<void> {
  /* ---------------- interval ---------------- */

  await test('a new interval task first fires one interval from now', () => {
    const now = local(2026, 6, 15, 10, 0)
    const schedule: Schedule = { kind: 'interval', everyMinutes: 60 }

    // Not "immediately": saving an hourly task at 10:00 should not fire at 10:00.
    assert.equal(nextRun(schedule, { from: now }), now + HOUR)
  })

  await test('an interval counts from the last run, not from now', () => {
    const lastRunAt = local(2026, 6, 15, 10, 0)
    const now = local(2026, 6, 15, 10, 20)

    assert.equal(
      nextRun({ kind: 'interval', everyMinutes: 60 }, { from: now, lastRunAt }),
      lastRunAt + HOUR
    )
  })

  await test('missed intervals collapse into one run instead of a burst', () => {
    // The app was shut for three days with an hourly task — that is 72 missed
    // slots. Replaying them would fire 72 requests at startup.
    const lastRunAt = local(2026, 6, 12, 10, 0)
    const now = local(2026, 6, 15, 10, 0)

    assert.equal(nextRun({ kind: 'interval', everyMinutes: 60 }, { from: now, lastRunAt }), now)
  })

  await test('an interval below the floor is raised, never zero', () => {
    const now = local(2026, 6, 15, 10, 0)
    const next = nextRun({ kind: 'interval', everyMinutes: 0 }, { from: now })

    assert.ok(next !== null && next > now, 'a zero interval must not resolve to "now, forever"')
    assert.equal(next, now + MINUTE)
  })

  /* ---------------- daily ---------------- */

  await test('a daily task fires later today when its time has not passed', () => {
    const now = local(2026, 6, 15, 8, 0)

    assert.equal(
      nextRun({ kind: 'daily', atMinutes: 9 * 60 + 30 }, { from: now }),
      local(2026, 6, 15, 9, 30)
    )
  })

  await test('a daily task rolls to tomorrow once its time has passed', () => {
    const now = local(2026, 6, 15, 10, 0)

    assert.equal(
      nextRun({ kind: 'daily', atMinutes: 9 * 60 + 30 }, { from: now }),
      local(2026, 6, 16, 9, 30)
    )
  })

  await test('a daily task exactly on its own time does not refire', () => {
    const now = local(2026, 6, 15, 9, 30)

    // Strictly-later, or a task firing at 09:30 would immediately be due again.
    assert.equal(
      nextRun({ kind: 'daily', atMinutes: 9 * 60 + 30 }, { from: now }),
      local(2026, 6, 16, 9, 30)
    )
  })

  await test('a daily task keeps its wall-clock time all year, DST included', () => {
    // Every next-run over a full year must land on the same clock face and be
    // strictly in the future. Adding 24h of milliseconds instead of stepping a
    // local day breaks both on the two changeover weekends.
    withTimezone('America/New_York', () => {
      const atMinutes = 9 * 60 + 30
      let cursor = local(2026, 1, 1, 0, 0)

      for (let day = 0; day < 365; day++) {
        const next = nextRun({ kind: 'daily', atMinutes }, { from: cursor })
        assert.ok(next !== null)
        assert.ok(
          (next as number) > cursor,
          `went backwards on day ${day}: ${new Date(next as number).toString()}`
        )

        const fired = new Date(next as number)
        assert.equal(
          fired.getHours() * 60 + fired.getMinutes(),
          atMinutes,
          `drifted to ${fired.toString()} on day ${day}`
        )
        cursor = (next as number) + MINUTE
      }
    })
  })

  await test('a daily task crosses the spring-forward night exactly once', () => {
    withTimezone('America/New_York', () => {
      // Clocks jump 02:00 -> 03:00 on 8 March 2026, making that day 23 hours.
      const beforeChange = local(2026, 3, 7, 10, 0)
      const next = nextRun({ kind: 'daily', atMinutes: 9 * 60 }, { from: beforeChange })

      assert.equal(next, local(2026, 3, 8, 9, 0))
      assert.ok((next as number) > beforeChange)
    })
  })

  await test('a midnight task on the fall-back night is not scheduled into the past', () => {
    withTimezone('America/New_York', () => {
      // The case that actually breaks. On 1 November 2026 the clocks go back at
      // 02:00, making the day 25 hours long — so `from + 24h` from 00:30 lands
      // at 23:30 the SAME day, and taking midnight of that day yields a moment
      // already behind us. The task is then permanently overdue: it fires, is
      // rescheduled into the past again, and runs in a loop.
      const justAfterMidnight = local(2026, 11, 1, 0, 30)
      const next = nextRun({ kind: 'daily', atMinutes: 0 }, { from: justAfterMidnight })

      assert.ok(next !== null)
      assert.ok(
        (next as number) > justAfterMidnight,
        `scheduled into the past: ${new Date(next as number).toString()}`
      )
      assert.equal(next, local(2026, 11, 2, 0, 0))
    })
  })

  await test('a weekly task holds its time across a DST change too', () => {
    withTimezone('America/New_York', () => {
      const friday = local(2026, 10, 30, 10, 0)
      assert.equal(new Date(friday).getDay(), 5)

      // Next Friday is on the far side of the November changeover.
      const next = nextRun({ kind: 'weekly', days: [5], atMinutes: 9 * 60 }, { from: friday })
      assert.equal(next, local(2026, 11, 6, 9, 0))

      const fired = new Date(next as number)
      assert.equal(fired.getHours(), 9)
    })
  })

  /* ---------------- weekly ---------------- */

  await test('a weekly task picks the next matching weekday', () => {
    // 15 June 2026 is a Monday.
    const monday = local(2026, 6, 15, 10, 0)
    assert.equal(new Date(monday).getDay(), 1, 'fixture assumption: 15 June 2026 is a Monday')

    // Wednesday and Friday, at 09:00 — from Monday morning that is Wednesday.
    const next = nextRun({ kind: 'weekly', days: [3, 5], atMinutes: 9 * 60 }, { from: monday })
    assert.equal(next, local(2026, 6, 17, 9, 0))
  })

  await test('a weekly task wraps into next week when the day has passed', () => {
    const friday = local(2026, 6, 19, 18, 0)
    assert.equal(new Date(friday).getDay(), 5)

    // Only Fridays, and this Friday's 09:00 is behind us.
    assert.equal(
      nextRun({ kind: 'weekly', days: [5], atMinutes: 9 * 60 }, { from: friday }),
      local(2026, 6, 26, 9, 0)
    )
  })

  await test('a weekly task fires later the same day when its time is ahead', () => {
    const friday = local(2026, 6, 19, 7, 0)

    assert.equal(
      nextRun({ kind: 'weekly', days: [5], atMinutes: 9 * 60 }, { from: friday }),
      local(2026, 6, 19, 9, 0)
    )
  })

  await test('a weekly task with no days never fires', () => {
    const now = local(2026, 6, 15, 10, 0)

    assert.equal(nextRun({ kind: 'weekly', days: [], atMinutes: 540 }, { from: now }), null)
    assert.equal(
      nextRun({ kind: 'weekly', days: [9, -1, 1.5], atMinutes: 540 }, { from: now }),
      null,
      'out-of-range weekdays are dropped, not clamped into a real day'
    )
  })

  await test('duplicate weekdays do not change the answer', () => {
    const monday = local(2026, 6, 15, 10, 0)

    assert.equal(
      nextRun({ kind: 'weekly', days: [3, 3, 3], atMinutes: 9 * 60 }, { from: monday }),
      nextRun({ kind: 'weekly', days: [3], atMinutes: 9 * 60 }, { from: monday })
    )
  })

  /* ---------------- once ---------------- */

  await test('a one-off in the future fires at its moment', () => {
    const at = local(2026, 6, 20, 9, 0)

    assert.equal(nextRun({ kind: 'once', atEpochMs: at }, { from: local(2026, 6, 15) }), at)
  })

  await test('a one-off that has already run never schedules itself again', () => {
    const at = local(2026, 6, 20, 9, 0)

    assert.equal(nextRun({ kind: 'once', atEpochMs: at }, { from: at, lastRunAt: at }), null)
    assert.equal(
      nextRun({ kind: 'once', atEpochMs: at }, { from: at + 7 * 24 * HOUR, lastRunAt: at }),
      null
    )
  })

  await test('a one-off missed while the app was closed still runs, once', () => {
    // "Run this at 9am" that silently evaporates because the laptop was shut is
    // the worst outcome: no run, and no sign that anything was meant to happen.
    const at = local(2026, 6, 20, 9, 0)
    const reopened = local(2026, 6, 20, 11, 30)

    assert.equal(
      nextRun({ kind: 'once', atEpochMs: at }, { from: reopened }),
      reopened,
      'an unfired one-off should catch up on the next launch'
    )
  })

  /* ---------------- validation ---------------- */

  await test('validation rejects exactly the schedules that would misfire', () => {
    assert.equal(validateSchedule({ kind: 'interval', everyMinutes: 60 }), null)
    assert.ok(validateSchedule({ kind: 'interval', everyMinutes: 0 }))
    assert.ok(validateSchedule({ kind: 'interval', everyMinutes: Number.NaN }))

    assert.equal(validateSchedule({ kind: 'daily', atMinutes: 0 }), null)
    assert.equal(validateSchedule({ kind: 'daily', atMinutes: 1439 }), null)
    assert.ok(validateSchedule({ kind: 'daily', atMinutes: 1440 }))
    assert.ok(validateSchedule({ kind: 'daily', atMinutes: -1 }))

    assert.ok(validateSchedule({ kind: 'weekly', days: [], atMinutes: 540 }))
    assert.equal(validateSchedule({ kind: 'weekly', days: [1], atMinutes: 540 }), null)

    assert.ok(validateSchedule({ kind: 'once', atEpochMs: Number.NaN }))
  })

  /* ---------------- formatting ---------------- */

  await test('clock text round-trips and refuses nonsense', () => {
    assert.equal(formatClock(9 * 60 + 5), '09:05')
    assert.equal(formatClock(0), '00:00')
    assert.equal(formatClock(23 * 60 + 59), '23:59')

    assert.equal(parseClock('09:05'), 9 * 60 + 5)
    assert.equal(parseClock('9:05'), 9 * 60 + 5)
    assert.equal(parseClock(' 23:59 '), 23 * 60 + 59)

    assert.equal(parseClock('24:00'), null)
    assert.equal(parseClock('09:60'), null)
    assert.equal(parseClock('nine'), null)
    assert.equal(parseClock(''), null)
  })

  await test('every schedule describes itself in a readable sentence', () => {
    assert.equal(describeSchedule({ kind: 'interval', everyMinutes: 30 }), 'Every 30 min')
    assert.equal(describeSchedule({ kind: 'interval', everyMinutes: 60 }), 'Every hour')
    assert.equal(describeSchedule({ kind: 'interval', everyMinutes: 120 }), 'Every 2 hours')
    assert.equal(describeSchedule({ kind: 'interval', everyMinutes: 90 }), 'Every 1h 30m')
    assert.equal(describeSchedule({ kind: 'interval', everyMinutes: 1440 }), 'Every day')

    assert.equal(describeSchedule({ kind: 'daily', atMinutes: 9 * 60 }), 'Daily at 09:00')
    assert.equal(
      describeSchedule({ kind: 'weekly', days: [1, 5], atMinutes: 9 * 60 + 30 }),
      `${DAY_NAMES[1]}, ${DAY_NAMES[5]} at 09:30`
    )
    assert.equal(
      describeSchedule({ kind: 'weekly', days: [0, 1, 2, 3, 4, 5, 6], atMinutes: 9 * 60 }),
      'Daily at 09:00',
      'every day of the week is a daily schedule, and should read like one'
    )
  })
}
