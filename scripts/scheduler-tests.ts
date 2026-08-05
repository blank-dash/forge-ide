/**
 * Tests for the unattended task scheduler.
 *
 * Driven by a fake clock and a fake timer, so the whole suite runs instantly
 * and covers the cases that only show up after days of real time: an overlong
 * timer overflowing, a run outlasting its own interval, a laptop waking to a
 * pile of missed slots.
 */
import assert from 'node:assert/strict'
import { Scheduler, type SchedulerDeps, type SchedulerEvent, type TimerHandle } from '../src/main/scheduler'
import type { ScheduledTask, TaskRunResult } from '../src/shared/types'

const MINUTE = 60_000
const HOUR = 60 * MINUTE

function emptyUsage(): TaskRunResult['usage'] {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, costUsd: 0 }
}

function makeTask(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: 'task-1',
    name: 'Test task',
    prompt: 'do the thing',
    schedule: { kind: 'interval', everyMinutes: 60 },
    enabled: true,
    permission: 'read-only',
    model: '',
    notify: false,
    createdAt: 0,
    nextRunAt: 0,
    ...overrides
  }
}

/** A clock, a timer and a task list under the test's control. */
function harness(options: {
  tasks: ScheduledTask[]
  now?: number
  run?: (task: ScheduledTask) => Promise<TaskRunResult>
}) {
  const state = {
    now: options.now ?? 0,
    tasks: options.tasks,
    events: [] as SchedulerEvent[],
    saved: [] as ScheduledTask[],
    runs: [] as string[],
    /** Armed delay of the current timer, or null when nothing is armed. */
    armed: null as number | null,
    fire: null as (() => void) | null
  }

  const deps: SchedulerDeps = {
    now: () => state.now,
    list: () => state.tasks,
    save: (task) => {
      state.saved.push(task)
      state.tasks = state.tasks.map((entry) => (entry.id === task.id ? task : entry))
    },
    run:
      options.run ??
      (async (task) => {
        state.runs.push(task.id)
        return {
          startedAt: state.now,
          durationMs: 0,
          status: 'ok',
          summary: 'done',
          usage: emptyUsage(),
          sessionId: 'session-1'
        }
      }),
    emit: (event) => state.events.push(event),
    setTimer: (fn, ms) => {
      state.armed = ms
      state.fire = fn
      return { id: 1 } as TimerHandle
    },
    clearTimer: () => {
      state.armed = null
      state.fire = null
    }
  }

  return { state, deps, scheduler: new Scheduler(deps) }
}

export async function runSchedulerTests(
  test: (name: string, fn: () => Promise<void> | void) => Promise<void>
): Promise<void> {
  await test('one timer is armed for the soonest task, not one per task', () => {
    const { state, scheduler } = harness({
      now: 1_000,
      tasks: [
        makeTask({ id: 'a', nextRunAt: 1_000 + 5 * MINUTE }),
        makeTask({ id: 'b', nextRunAt: 1_000 + 2 * MINUTE }),
        makeTask({ id: 'c', nextRunAt: 1_000 + 9 * MINUTE })
      ]
    })

    scheduler.refresh()
    assert.equal(state.armed, 2 * MINUTE)
  })

  await test('nothing is armed when there is nothing to run', () => {
    const { state, scheduler } = harness({
      tasks: [
        makeTask({ id: 'a', enabled: false, nextRunAt: 5_000 }),
        makeTask({ id: 'b', nextRunAt: null })
      ]
    })

    scheduler.refresh()
    assert.equal(state.armed, null, 'a disabled or never-firing task must not hold a timer open')
  })

  await test('a wait longer than a signed 32-bit millisecond is broken into hops', () => {
    // setTimeout overflows past 2^31-1 ms and fires immediately, which would
    // turn a task scheduled a month out into one that runs continuously.
    const farFuture = 60 * 24 * 60 * MINUTE // 60 days
    const { state, scheduler } = harness({
      now: 0,
      tasks: [makeTask({ nextRunAt: farFuture })]
    })

    scheduler.refresh()
    assert.ok(state.armed !== null)
    assert.ok(
      (state.armed as number) <= 2_147_483_647,
      `armed ${state.armed}ms, which setTimeout cannot represent`
    )
    assert.ok((state.armed as number) > 0)
  })

  await test('a due task in the past still arms a real delay, never zero', () => {
    const { state, scheduler } = harness({
      now: 10 * HOUR,
      tasks: [makeTask({ nextRunAt: 1 * HOUR })]
    })

    scheduler.refresh()
    assert.ok((state.armed as number) > 0, 'a zero-delay timer would spin the event loop')
  })

  await test('a nonsense next-run stamp is ignored, not spun on', () => {
    // NaN reaches setTimeout as zero, the timer fires, nothing compares true
    // against NaN so nothing runs, and it re-arms at zero — a busy loop that
    // pins a core. A hand-edited tasks.json is enough to cause it.
    const { state, scheduler } = harness({
      now: 1_000,
      tasks: [
        makeTask({ id: 'broken', nextRunAt: Number.NaN }),
        makeTask({ id: 'also-broken', nextRunAt: Number.POSITIVE_INFINITY })
      ]
    })

    scheduler.refresh()
    assert.equal(state.armed, null, 'an unusable stamp must not arm a timer at all')
  })

  await test('a broken task does not stop a healthy one from being scheduled', () => {
    const { state, scheduler } = harness({
      now: 1_000,
      tasks: [
        makeTask({ id: 'broken', nextRunAt: Number.NaN }),
        makeTask({ id: 'fine', nextRunAt: 1_000 + 5 * MINUTE })
      ]
    })

    scheduler.refresh()
    assert.equal(state.armed, 5 * MINUTE)
  })

  await test('a tick runs the due tasks and leaves the others alone', async () => {
    const now = 10 * HOUR
    const { state, scheduler } = harness({
      now,
      tasks: [
        makeTask({ id: 'due', nextRunAt: now - MINUTE }),
        makeTask({ id: 'also-due', nextRunAt: now }),
        makeTask({ id: 'later', nextRunAt: now + HOUR }),
        makeTask({ id: 'off', enabled: false, nextRunAt: now - HOUR })
      ]
    })

    await scheduler.tick()

    assert.deepEqual(state.runs, ['due', 'also-due'])
  })

  await test('due tasks run one after another, never at once', async () => {
    const now = 10 * HOUR
    let concurrent = 0
    let peak = 0

    const { state, scheduler } = harness({
      now,
      tasks: [
        makeTask({ id: 'a', nextRunAt: now }),
        makeTask({ id: 'b', nextRunAt: now }),
        makeTask({ id: 'c', nextRunAt: now })
      ],
      run: async (task) => {
        concurrent += 1
        peak = Math.max(peak, concurrent)
        await Promise.resolve()
        concurrent -= 1
        return {
          startedAt: now,
          durationMs: 0,
          status: 'ok',
          summary: task.id,
          usage: emptyUsage(),
          sessionId: 's'
        }
      }
    })

    await scheduler.tick()

    assert.equal(peak, 1, 'three tasks coming due together must not fire three requests at once')
    assert.equal(state.saved.length, 3)
  })

  await test('the next run is measured from when the last one finished', async () => {
    const start = 10 * HOUR
    const { state, scheduler } = harness({
      now: start,
      tasks: [
        makeTask({ schedule: { kind: 'interval', everyMinutes: 60 }, nextRunAt: start })
      ],
      run: async () => {
        // The run itself takes 90 minutes — longer than its own interval.
        state.now += 90 * MINUTE
        return {
          startedAt: start,
          durationMs: 90 * MINUTE,
          status: 'ok',
          summary: 'slow',
          usage: emptyUsage(),
          sessionId: 's'
        }
      }
    })

    await scheduler.tick()

    const saved = state.saved[0]
    assert.equal(saved.lastRunAt, start + 90 * MINUTE)
    assert.equal(
      saved.nextRunAt,
      start + 90 * MINUTE + HOUR,
      'anchoring on the due time instead would make an overrunning task due the instant it finished'
    )
  })

  await test('a task that overruns is not started a second time', async () => {
    const now = 10 * HOUR
    let started = 0
    let release = (): void => undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })

    const { scheduler } = harness({
      now,
      tasks: [makeTask({ id: 'slow', nextRunAt: now })],
      run: async () => {
        started += 1
        await gate
        return {
          startedAt: now,
          durationMs: 0,
          status: 'ok',
          summary: '',
          usage: emptyUsage(),
          sessionId: 's'
        }
      }
    })

    const first = scheduler.tick()
    // A second tick arrives while the first run is still in flight.
    const second = scheduler.tick()
    assert.equal(scheduler.isRunning('slow'), true)

    release()
    await Promise.all([first, second])

    assert.equal(started, 1, 'the same task must never be running twice')
    assert.equal(scheduler.isRunning('slow'), false)
  })

  await test('a failing run is recorded and the scheduler survives it', async () => {
    const now = 10 * HOUR
    const { state, scheduler } = harness({
      now,
      tasks: [makeTask({ id: 'boom', nextRunAt: now })],
      run: async () => {
        throw new Error('provider exploded')
      }
    })

    await scheduler.tick()

    const saved = state.saved[0]
    assert.equal(saved.lastRun?.status, 'error')
    assert.equal(saved.lastRun?.error, 'provider exploded')
    assert.ok(saved.nextRunAt !== null, 'a failed run must still be scheduled to try again')
    assert.equal(scheduler.isRunning('boom'), false)
  })

  await test('every run is announced, started and finished', async () => {
    const now = 10 * HOUR
    const { state, scheduler } = harness({
      now,
      tasks: [makeTask({ id: 'x', nextRunAt: now })]
    })

    await scheduler.tick()

    assert.deepEqual(
      state.events.map((event) => event.type),
      ['task_started', 'task_finished']
    )
  })

  await test('running a task by hand ignores its schedule', async () => {
    const now = 10 * HOUR
    const { state, scheduler } = harness({
      now,
      tasks: [makeTask({ id: 'later', nextRunAt: now + 10 * HOUR })]
    })

    const result = await scheduler.runNow('later')

    assert.equal(result?.status, 'ok')
    assert.deepEqual(state.runs, ['later'])
    assert.equal(await scheduler.runNow('missing'), null)
  })

  await test('a disabled task run by hand does not reschedule itself', async () => {
    const now = 10 * HOUR
    const { state, scheduler } = harness({
      now,
      tasks: [makeTask({ id: 'off', enabled: false, nextRunAt: null })]
    })

    await scheduler.runNow('off')

    assert.deepEqual(state.runs, ['off'], 'running by hand should work even when disabled')
    assert.equal(state.saved[0].nextRunAt, null, 'but it must not switch itself back on')
  })

  await test('a one-off task does not schedule itself again', async () => {
    const now = 10 * HOUR
    const { state, scheduler } = harness({
      now,
      tasks: [
        makeTask({ id: 'once', schedule: { kind: 'once', atEpochMs: now }, nextRunAt: now })
      ]
    })

    await scheduler.tick()

    assert.equal(state.saved[0].nextRunAt, null)
    assert.equal(state.armed, null, 'and it must not leave a timer armed behind it')
  })

  await test('stopping prevents further runs', async () => {
    const now = 10 * HOUR
    const { state, scheduler } = harness({
      now,
      tasks: [makeTask({ id: 'a', nextRunAt: now })]
    })

    scheduler.refresh()
    scheduler.stop()
    await scheduler.tick()

    assert.deepEqual(state.runs, [])
    assert.equal(state.armed, null, 'a stopped scheduler must not hold the app open with a timer')
  })
}
