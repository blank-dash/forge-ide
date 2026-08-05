import { useCallback, useEffect, useMemo, useState } from 'react'
import { describeSchedule } from '@shared/schedule'
import { PERMISSION_LABELS, validateTask } from '@shared/tasks'
import type { ScheduledTask, TaskPermission } from '@shared/types'
import type { TaskEntry } from '../../preload'
import { useT } from '../i18n'
import { emptyView, useStore } from '../store'
import { toEntries } from './ConversationList'
import ScheduleFields from './ScheduleFields'
import Select from './Select'
import Spinner from './Spinner'

/** A blank task, ready to edit. Read-only by default — the level that cannot bite. */
function blankTask(): Partial<ScheduledTask> {
  return {
    name: '',
    prompt: '',
    schedule: { kind: 'daily', atMinutes: 9 * 60 },
    enabled: true,
    permission: 'read-only',
    model: '',
    notify: true
  }
}

/**
 * Work the agent does on its own.
 *
 * The list is deliberately blunt about two things a scheduler usually hides:
 * when each task will next run, and what it is allowed to touch. Both are the
 * questions you actually have when you come back to a task you wrote weeks ago.
 */
export default function ScheduledTasks() {
  const t = useT()
  const [tasks, setTasks] = useState<TaskEntry[]>([])
  const [editing, setEditing] = useState<Partial<ScheduledTask> | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const pushError = useStore((state) => state.pushError)

  // "in 12 min" is only true for a minute. Without this the countdown freezes
  // at whatever it said when the pane opened.
  const [, tick] = useState(0)
  useEffect(() => {
    const timer = setInterval(() => tick((value) => value + 1), 30_000)
    return () => clearInterval(timer)
  }, [])

  const refresh = useCallback(async () => {
    try {
      setTasks(await window.forge.tasks.list())
    } catch (error) {
      pushError((error as Error).message)
    } finally {
      setLoading(false)
    }
  }, [pushError])

  useEffect(() => {
    void refresh()
    // The main process owns the truth here: a task can start, finish or
    // reschedule itself with nobody touching this screen.
    return window.forge.tasks.onChanged(() => void refresh())
  }, [refresh])

  const save = async (task: Partial<ScheduledTask>): Promise<void> => {
    try {
      await window.forge.tasks.save(task)
      setEditing(null)
      void refresh()
    } catch (error) {
      pushError((error as Error).message)
    }
  }

  const remove = async (id: string): Promise<void> => {
    setBusy(id)
    try {
      await window.forge.tasks.remove(id)
      void refresh()
    } finally {
      setBusy(null)
    }
  }

  const runNow = async (id: string): Promise<void> => {
    setBusy(id)
    try {
      await window.forge.tasks.run(id)
    } catch (error) {
      pushError((error as Error).message)
    } finally {
      setBusy(null)
      void refresh()
    }
  }

  if (editing) {
    return <TaskEditor task={editing} onCancel={() => setEditing(null)} onSave={save} />
  }

  return (
    <div className="tasks">
      <header className="tasks-head">
        <div>
          <h1>{t('Scheduled tasks')}</h1>
          <p className="tasks-sub">
            {t(
              'Prompts the agent runs on its own, on a schedule. Each one gets its own conversation you can open and read.'
            )}
          </p>
        </div>
        <button className="btn btn-primary" onClick={() => setEditing(blankTask())}>
          {t('New task')}
        </button>
      </header>

      {loading && <div className="empty-hint">{t('Loading…')}</div>}

      {!loading && tasks.length === 0 && (
        <div className="tasks-empty">
          <p>{t('Nothing scheduled yet.')}</p>
          <p className="hint">
            {t(
              'A task is just a prompt with a clock attached — "summarise what changed today", "check the build every morning", "look for TODOs left in the code this week".'
            )}
          </p>
        </div>
      )}

      <div className="tasks-list">
        {tasks.map((task) => (
          <TaskRow
            key={task.id}
            task={task}
            busy={busy === task.id}
            onEdit={() => setEditing(task)}
            onRemove={() => void remove(task.id)}
            onRun={() => void runNow(task.id)}
            onToggle={() => void save({ ...task, enabled: !task.enabled })}
          />
        ))}
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */

type RowProps = {
  task: TaskEntry
  busy: boolean
  onEdit(): void
  onRemove(): void
  onRun(): void
  onToggle(): void
}

function TaskRow({ task, busy, onEdit, onRemove, onRun, onToggle }: RowProps) {
  const t = useT()
  const [confirming, setConfirming] = useState(false)

  const openRun = async (): Promise<void> => {
    const sessionId = task.lastRun?.sessionId
    if (!sessionId) return

    const store = useStore.getState()
    const live = await window.forge.agent.state(sessionId).catch(() => null)

    if (live) {
      await window.forge.agent.activate(sessionId)
      store.switchSession(sessionId, {
        ...emptyView(),
        entries: toEntries(live.messages),
        totals: live.totals,
        running: live.running,
        changes: live.changes
      })
    } else {
      const record = await window.forge.sessions.load(sessionId).catch(() => null)
      if (!record) return
      store.switchSession(record.id, {
        ...emptyView(),
        entries: toEntries(record.messages),
        totals: record.totals
      })
      store.setSessionModel(record.model ?? null)
    }
    store.patchUi({ chatPane: 'chats' })
  }

  return (
    <div className={`task-row ${task.enabled ? '' : 'off'}`}>
      <label className="switch task-toggle" title={t('Enabled')}>
        <input
          type="checkbox"
          checked={task.enabled}
          disabled={task.running}
          onChange={onToggle}
        />
      </label>

      <button className="task-main" onClick={onEdit}>
        <span className="task-name">
          {task.running && <Spinner className="task-spinner" />}
          {task.name}
        </span>

        <span className="task-meta">
          {t(describeSchedule(task.schedule))}
          <span className={`task-perm perm-${task.permission}`}>
            {t(PERMISSION_LABELS[task.permission])}
          </span>
          {task.enabled && task.nextRunAt !== null && (
            <span className="task-next">
              {t('next')} {relative(task.nextRunAt, t)}
            </span>
          )}
        </span>

        {task.lastRun && (
          <span className={`task-last status-${task.lastRun.status}`}>
            {task.lastRun.status === 'error' && `${t('Failed')}: ${task.lastRun.error ?? ''}`}
            {task.lastRun.status === 'cancelled' && t('Stopped before it finished.')}
            {task.lastRun.status === 'truncated' &&
              `${t('Ran out of steps')} — ${task.lastRun.summary}`}
            {task.lastRun.status === 'ok' &&
              (task.lastRun.summary || t('Finished with nothing to report.'))}
          </span>
        )}
      </button>

      <div className="task-actions">
        {task.lastRun?.sessionId && (
          <button className="icon-btn" title={t('Open the last run')} onClick={() => void openRun()}>
            ↗
          </button>
        )}
        <button className="icon-btn" title={t('Run now')} disabled={busy || task.running} onClick={onRun}>
          {busy || task.running ? <Spinner /> : '▷'}
        </button>

        {confirming ? (
          <>
            <button className="icon-btn danger" title={t('Delete')} onClick={onRemove}>
              {t('sure?')}
            </button>
            <button className="icon-btn" onClick={() => setConfirming(false)}>
              ×
            </button>
          </>
        ) : (
          <button className="icon-btn danger" title={t('Delete')} onClick={() => setConfirming(true)}>
            ×
          </button>
        )}
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */

type EditorProps = {
  task: Partial<ScheduledTask>
  onCancel(): void
  onSave(task: Partial<ScheduledTask>): void
}

function TaskEditor({ task, onCancel, onSave }: EditorProps) {
  const t = useT()
  const [draft, setDraft] = useState(task)
  const providers = useStore((state) => state.settings.providers)

  const patch = (partial: Partial<ScheduledTask>): void =>
    setDraft((current) => ({ ...current, ...partial }))

  const problem = validateTask({
    prompt: draft.prompt ?? '',
    schedule: draft.schedule ?? { kind: 'interval', everyMinutes: 60 }
  })

  const models = useMemo(
    () => [
      { value: '', label: t('Whatever is active'), hint: t('Follows the model picker') },
      ...providers
        .filter((provider) => provider.enabled && provider.apiKey)
        .flatMap((provider) =>
          provider.models.map((model) => ({
            value: `${provider.id}:${model.id}`,
            label: model.label,
            hint: provider.name
          }))
        )
    ],
    [providers, t]
  )

  return (
    <div className="tasks">
      <header className="tasks-head">
        <h1>{draft.id ? t('Edit task') : t('New task')}</h1>
      </header>

      <div className="field">
        <label>{t('Name')}</label>
        <input
          className="input"
          value={draft.name ?? ''}
          placeholder={t('Morning summary')}
          onChange={(event) => patch({ name: event.target.value })}
        />
      </div>

      <div className="field">
        <label>{t('What should it do?')}</label>
        <textarea
          className="textarea"
          rows={5}
          value={draft.prompt ?? ''}
          placeholder={t('Look at what changed in git today and summarise it in a few lines.')}
          onChange={(event) => patch({ prompt: event.target.value })}
        />
        <div className="hint">
          {t(
            'Written exactly as you would type it in the chat. The agent has the same tools, limited to what you allow below.'
          )}
        </div>
      </div>

      <ScheduleFields
        value={draft.schedule ?? { kind: 'daily', atMinutes: 9 * 60 }}
        onChange={(schedule) => patch({ schedule })}
      />

      <div className="row">
        <div className="field">
          <label>{t('Allowed to')}</label>
          <Select
            value={draft.permission ?? 'read-only'}
            onChange={(permission) => patch({ permission: permission as TaskPermission })}
            options={[
              {
                value: 'read-only',
                label: t('Read only'),
                hint: t('Cannot change anything. Safe to forget about.')
              },
              {
                value: 'edit',
                label: t('Edit files'),
                hint: t('Writes to the workspace. No commands.')
              },
              {
                value: 'full',
                label: t('Everything'),
                hint: t('Runs commands too, with no prompts. Be sure.')
              }
            ]}
          />
        </div>

        <div className="field">
          <label>{t('Model')}</label>
          <Select
            value={draft.model ?? ''}
            onChange={(model) => patch({ model })}
            options={models}
          />
        </div>
      </div>

      <label className="switch">
        <input
          type="checkbox"
          checked={draft.notify ?? true}
          onChange={(event) => patch({ notify: event.target.checked })}
        />
        {t('Notify me when it finishes')}
      </label>

      {draft.permission === 'full' && (
        <div className="task-warning">
          {t(
            'At this level the task runs commands with no approval, on a schedule, whether or not you are at the machine. Only use it for something you would happily watch run.'
          )}
        </div>
      )}

      <div className="tasks-footer">
        {problem && <span className="field-error">{problem}</span>}
        <span style={{ flex: 1 }} />
        <button className="btn ghost" onClick={onCancel}>
          {t('Cancel')}
        </button>
        <button className="btn btn-primary" disabled={problem !== null} onClick={() => onSave(draft)}>
          {t('Save task')}
        </button>
      </div>
    </div>
  )
}

/** "in 12 min", "in 3 h", "tomorrow" — whichever reads fastest, translated. */
function relative(at: number, t: (text: string) => string): string {
  const delta = at - Date.now()
  if (delta <= 0) return t('now')

  const minutes = Math.round(delta / 60_000)
  if (minutes < 60) return `${t('in')} ${minutes} ${t('min')}`

  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${t('in')} ${hours} ${t('h')}`

  const days = Math.round(hours / 24)
  return days === 1 ? t('tomorrow') : `${t('in')} ${days} ${t('days')}`
}
