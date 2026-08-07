import { nextRun, type Schedule } from '@shared/schedule'
import type { ScheduledTask, TaskRunResult } from '@shared/types'

/**
 * Decides when unattended tasks run, and makes sure they only run one at a time.
 *
 * Everything the outside world provides is injected, including the clock and
 * the timer, so this can be tested against a fake clock instead of by waiting.
 * It deliberately knows nothing about Electron, the filesystem or the agent.
 */

/** Opaque to this module; whatever the injected timer hands back. */
export type TimerHandle = unknown

export interface SchedulerDeps {
  now(): number
  /** Read afresh each time — tasks change underneath the scheduler. */
  list(): ScheduledTask[]
  /** Persist a task after a run has updated its bookkeeping. */
  save(task: ScheduledTask): Promise<void> | void
  /** Run the prompt. Must resolve, never reject: a failure is a result too. */
  run(task: ScheduledTask): Promise<TaskRunResult>
  emit(event: SchedulerEvent): void
  setTimer(fn: () => void, ms: number): TimerHandle
  clearTimer(handle: TimerHandle): void
}

export type SchedulerEvent =
  | { type: 'task_started'; taskId: string }
  | { type: 'task_finished'; taskId: string; result: TaskRunResult }
  | { type: 'tasks_changed' }

/**
 * setTimeout stores its delay in a signed 32-bit int. Anything larger overflows
 * and fires immediately — a task scheduled a month out would run right now, and
 * keep running. Long waits are broken into hops instead.
 */
const MAX_TIMER_MS = 2_147_483_647

/** Never arm a zero-delay timer; it would spin the loop. */
const MIN_TIMER_MS = 250

export class Scheduler {
  private timer: TimerHandle | null = null
  /** Tasks mid-run, so a slow one is never started a second time. */
  private running = new Set<string>()
  private stopped = false
  /** Set while the workspace is changing; cleared by the next refresh(). */
  private paused = false

  constructor(private readonly deps: SchedulerDeps) {}

  /**
   * Recomputes when each task is next due and arms one timer for the soonest.
   *
   * A timer per task would drift apart and leak on every edit; one timer that
   * is re-armed after every change stays correct with no bookkeeping.
   */
  refresh(): void {
    if (this.stopped) return
    this.paused = false

    this.disarm()

    const now = this.deps.now()
    const due = this.deps
      .list()
      .filter(isArmable)
      .map((task) => task.nextRunAt as number)

    if (due.length === 0) return

    const soonest = Math.min(...due)
    const delay = Math.max(MIN_TIMER_MS, soonest - now)

    // Long waits hop rather than overflow. Each hop re-reads the task list, so
    // an edit made in the meantime is picked up anyway.
    this.timer = this.deps.setTimer(
      () => {
        this.timer = null
        void this.tick()
      },
      Math.min(delay, MAX_TIMER_MS)
    )
  }

  /** Runs everything due right now, then re-arms. */
  async tick(): Promise<void> {
    if (this.stopped || this.paused) return

    const now = this.deps.now()
    const due = this.deps
      .list()
      .filter((task) => isArmable(task) && (task.nextRunAt as number) <= now)

    // Sequential on purpose. Firing five tasks at once after a laptop wakes is
    // exactly the burst of API calls this whole design tries to avoid.
    for (const task of due) {
      if (this.stopped) break
      await this.execute(task)
    }

    this.refresh()
  }

  /** Runs a task immediately, outside its schedule. */
  async runNow(id: string): Promise<TaskRunResult | null> {
    const task = this.deps.list().find((entry) => entry.id === id)
    if (!task) return null

    const result = await this.execute(task)
    this.refresh()
    return result
  }

  /** True while a given task is mid-run. */
  isRunning(id: string): boolean {
    return this.running.has(id)
  }

  /** Stops arming new timers for good. In-flight runs finish on their own. */
  stop(): void {
    this.stopped = true
    this.disarm()
  }

  /**
   * Disarms until the next `refresh()`.
   *
   * Used while the workspace is changing: tasks resolve their working directory
   * lazily, so a timer that fires during the switch would run the old folder's
   * task against the new one.
   */
  stopUntilRefreshed(): void {
    this.disarm()
    this.paused = true
  }

  /* ---------------------------------------------------------------- */

  private async execute(task: ScheduledTask): Promise<TaskRunResult | null> {
    // A task that overruns its own interval must not stack up behind itself.
    if (this.running.has(task.id)) return null

    this.running.add(task.id)
    this.deps.emit({ type: 'task_started', taskId: task.id })

    let result: TaskRunResult
    try {
      result = await this.deps.run(task)
    } catch (error) {
      // deps.run is contracted not to reject, but a scheduler that dies on a
      // broken dependency would take every other task down with it.
      result = {
        startedAt: this.deps.now(),
        durationMs: 0,
        status: 'error',
        summary: '',
        error: (error as Error).message,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, costUsd: 0 },
        sessionId: ''
      }
    } finally {
      this.running.delete(task.id)
    }

    // Re-read rather than reusing the copy captured before the run: a run can
    // last hours, and anything the user changed meanwhile — a new schedule, or
    // switching the task off — would be silently reverted by writing back the
    // stale object.
    const current = this.deps.list().find((entry) => entry.id === task.id)
    if (!current) {
      // Deleted while it ran. Nothing to write back to.
      this.deps.emit({ type: 'task_finished', taskId: task.id, result })
      return result
    }

    // Anchored on completion, not on the moment it was due: a run that takes
    // longer than its own interval would otherwise be due again the instant it
    // finished, and the task would never stop running.
    const finishedAt = this.deps.now()
    const updated: ScheduledTask = {
      ...current,
      lastRunAt: finishedAt,
      lastRun: result,
      nextRunAt: current.enabled
        ? nextRun(current.schedule, { from: finishedAt, lastRunAt: finishedAt })
        : null
    }

    await this.deps.save(updated)
    this.deps.emit({ type: 'task_finished', taskId: task.id, result })
    return result
  }

  private disarm(): void {
    if (this.timer === null) return
    this.deps.clearTimer(this.timer)
    this.timer = null
  }
}

/**
 * Whether a task can be armed at all.
 *
 * The finite check is not paranoia: a NaN stamp — from a hand-edited tasks.json
 * or a schedule with a nonsense interval — propagates through Math.min into
 * setTimeout, which treats it as zero. The timer then fires immediately, finds
 * nothing due (every comparison against NaN is false), re-arms at zero, and
 * spins the process at full tilt.
 */
function isArmable(task: ScheduledTask): boolean {
  return task.enabled && task.nextRunAt !== null && Number.isFinite(task.nextRunAt)
}

/**
 * The next-run stamp a task should carry after being created or edited.
 *
 * Kept beside the scheduler so the store, the IPC layer and the scheduler all
 * agree on one answer rather than each computing their own.
 */
export function scheduleFrom(schedule: Schedule, now: number, lastRunAt?: number): number | null {
  return nextRun(schedule, { from: now, lastRunAt })
}
