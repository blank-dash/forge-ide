import { describeSchedule, validateSchedule } from './schedule'
import type { PermissionDecision, ScheduledTask, Settings, TaskPermission } from './types'

/**
 * The rules an unattended task runs under.
 *
 * Deliberately free of Node and Electron: this is the part that decides what a
 * task may touch, so it is also the part most worth testing, and the test
 * harness cannot load anything that imports `electron`.
 */

/** A task with its identity and derived fields filled in. */
export function normaliseTask(
  task: Partial<ScheduledTask>,
  now: number,
  nextRunAt: number | null
): ScheduledTask {
  const enabled = task.enabled ?? true

  return {
    id: task.id || '',
    name: (task.name ?? '').trim() || 'Untitled task',
    prompt: task.prompt ?? '',
    schedule: task.schedule ?? { kind: 'interval', everyMinutes: 60 },
    enabled,
    permission: task.permission ?? 'read-only',
    model: task.model ?? '',
    notify: task.notify ?? true,
    createdAt: task.createdAt ?? now,
    lastRunAt: task.lastRunAt,
    lastRun: task.lastRun,
    // A disabled task carries no next run, so nothing has to remember to check
    // `enabled` before arming a timer.
    nextRunAt: enabled ? nextRunAt : null
  }
}

/** Why this task cannot be saved, or null if it can. */
export function validateTask(task: Pick<ScheduledTask, 'prompt' | 'schedule'>): string | null {
  if (!task.prompt.trim()) return 'A task needs a prompt — what should the agent do?'
  return validateSchedule(task.schedule)
}

/** One line describing when and under what powers a task runs. */
export function describeTask(task: ScheduledTask): string {
  return `${describeSchedule(task.schedule)} · ${PERMISSION_LABELS[task.permission]}`
}

export const PERMISSION_LABELS: Record<TaskPermission, string> = {
  'read-only': 'read only',
  edit: 'can edit files',
  full: 'full access'
}

/**
 * The settings an unattended run works under.
 *
 * Read-only is not merely "refuse the edits": `readOnly` removes the mutating
 * tools from the schema, so the model is never offered them and never wastes a
 * turn being told no.
 *
 * `bypassPermissions` is the only flag that reaches every request kind. Setting
 * the two approval modes to 'auto' is not equivalent — an absolute path outside
 * the workspace raises an `external` request that both modes still send to the
 * dialog, and a task has no dialog.
 */
export function settingsForTask(
  base: Settings,
  permission: TaskPermission,
  model: string
): Settings {
  const withModel = model ? { ...base, activeModel: model } : base

  const saved = {
    ...withModel,
    // Always saved: the transcript is the only record of what an unattended run
    // did, and it is the thing you open when a task reports something odd.
    autoSaveSessions: true
  }

  switch (permission) {
    case 'read-only':
      return { ...saved, ...CONFINED, readOnly: true, bypassPermissions: false }
    case 'edit':
      return {
        ...saved,
        ...CONFINED,
        readOnly: false,
        bypassPermissions: false,
        // 'auto', not 'review': edits from a nightly task would otherwise pile
        // up in a review screen nobody opens, and the task's own follow-up runs
        // would not see its previous work.
        editApproval: 'auto',
        commandApproval: 'ask'
      }
    case 'full':
      return { ...saved, readOnly: false, bypassPermissions: true }
  }
}

/**
 * Strips the standing permissions a task must not inherit.
 *
 * Both of these were granted interactively — "always allow this command", "yes,
 * you may read that folder" — with the user watching a specific request in a
 * specific conversation. Carrying them into an unattended run silently widens
 * what the level below "full" can reach: an approved shell rule would let an
 * edit-only task run commands, and an approved external root would let it write
 * outside the workspace without raising anything.
 *
 * Deny rules are deliberately kept. They only ever narrow.
 */
const CONFINED: Pick<Settings, 'allowRules' | 'externalRoots'> = {
  allowRules: [],
  externalRoots: []
}

/**
 * How an unattended run answers a permission prompt.
 *
 * There is nobody to ask, so every request has to resolve to a decision here
 * and now. This is the only thing standing between a scheduled task and the
 * one unbounded wait in the agent loop.
 *
 * A denial carries a reason the model can read, so it adapts instead of
 * failing blind.
 */
export function decideForTask(
  permission: TaskPermission,
  kind: 'edit' | 'write' | 'shell' | 'external' | 'mcp',
  destructive = false
): PermissionDecision {
  if (permission === 'full') return { action: 'allow' }

  // Note what is deliberately not consulted: `preApproved`. Standing consent to
  // skip a prompt was given interactively, about a conversation the user was
  // watching. It does not carry into a run happening at 3am.
  if (permission === 'edit' && !destructive && (kind === 'edit' || kind === 'write')) {
    return { action: 'allow' }
  }

  return {
    action: 'deny',
    reason:
      `This is a scheduled task running unattended at the "${PERMISSION_LABELS[permission]}" ` +
      `level, so ${destructive ? 'deleting files' : describeKind(kind)} is not allowed. Work ` +
      `within that, and if the task cannot be done without it, say so plainly in your final ` +
      `message.`
  }
}

function describeKind(kind: 'edit' | 'write' | 'shell' | 'external' | 'mcp'): string {
  switch (kind) {
    case 'edit':
    case 'write':
      return 'changing files'
    case 'shell':
      return 'running commands'
    case 'external':
      return 'reaching outside the workspace folder'
    case 'mcp':
      return 'calling this MCP tool'
  }
}
