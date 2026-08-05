import { useEffect, useState } from 'react'
import type { TaskRunResult } from '@shared/types'
import { useT } from '../i18n'
import { emptyView, useStore } from '../store'
import { toEntries } from './ConversationList'

type Finished = {
  taskId: string
  taskName: string
  result: TaskRunResult
  /** Distinguishes two runs of the same task, so dismissing one is not permanent. */
  key: string
}

const AUTO_DISMISS_MS = 12_000

/**
 * What a scheduled task did, shown in the corner when it finishes.
 *
 * The OS notification only fires when the window is not in front, so this is
 * the in-app half of the same job: you were here, you saw it happen, and you
 * get one click to read the whole run.
 */
export default function TaskToast() {
  const t = useT()
  const [finished, setFinished] = useState<Finished | null>(null)
  const setTaskRunning = useStore((state) => state.setTaskRunning)

  useEffect(() => {
    return window.forge.tasks.onEvent((event) => {
      if (event.type === 'task_started') {
        setTaskRunning(event.taskId, true)
        return
      }
      if (event.type !== 'task_finished') return

      setTaskRunning(event.taskId, false)
      setFinished({
        taskId: event.taskId,
        taskName: event.taskName,
        result: event.result,
        key: `${event.taskId}-${event.result.startedAt}`
      })
    })
  }, [setTaskRunning])

  // Clicking the OS notification asks the renderer to open that conversation.
  useEffect(() => {
    return window.forge.tasks.onOpenSession((sessionId) => void openSession(sessionId))
  }, [])

  useEffect(() => {
    if (!finished) return
    // A failure stays up: it is the one you need to act on, and it is rare
    // enough that leaving it there is not noise.
    if (finished.result.status === 'error') return

    const timer = setTimeout(() => setFinished(null), AUTO_DISMISS_MS)
    return () => clearTimeout(timer)
  }, [finished])

  if (!finished) return null

  const failed = finished.result.status === 'error'
  const body = failed
    ? (finished.result.error ?? t('The run failed.'))
    : finished.result.status === 'cancelled'
      ? t('Stopped before it finished.')
      : finished.result.status === 'truncated'
        ? `${t('Ran out of steps')} — ${finished.result.summary}`
        : finished.result.summary || t('Finished with nothing to report.')

  return (
    <div className={`update-toast task-toast ${failed ? 'failed' : ''}`}>
      <span className={`update-dot ${failed ? 'bad' : ''}`} />

      <div className="update-body">
        <div className="update-title">{finished.taskName || t('Scheduled task')}</div>
        <div className="update-sub">{body}</div>
      </div>

      {finished.result.sessionId && (
        <button
          className="btn"
          onClick={() => {
            void openSession(finished.result.sessionId)
            setFinished(null)
          }}
        >
          {t('Open')}
        </button>
      )}

      <button className="icon-btn" title={t('Dismiss')} onClick={() => setFinished(null)}>
        ×
      </button>
    </div>
  )
}

/** Brings a run's conversation on screen, live if it is still open. */
async function openSession(sessionId: string): Promise<void> {
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
  }

  store.patchUi({ chatPane: 'chats' })
}
