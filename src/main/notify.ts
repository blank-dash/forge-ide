import { BrowserWindow, Notification } from 'electron'
import type { ScheduledTask, TaskRunResult } from '@shared/types'

/**
 * OS notifications for work that finished while you were elsewhere.
 *
 * The whole point of a scheduled task is that you are not watching, so the
 * result has to reach you outside the window. Everything here degrades quietly:
 * a platform without notification support, a user who turned them off, or a
 * missing Application User Model ID must never break the run that produced it.
 */

const MAX_BODY_CHARS = 220

export interface Notifier {
  taskFinished(task: ScheduledTask, result: TaskRunResult): void
}

export function createNotifier(
  getWindow: () => BrowserWindow | null,
  onOpenSession: (sessionId: string) => void
): Notifier {
  return {
    taskFinished(task, result) {
      if (!task.notify) return

      // Nothing to tell you about work you were watching happen.
      const window = getWindow()
      if (window?.isFocused() && window.isVisible()) return

      if (!Notification.isSupported()) return

      const failed = result.status === 'error'
      const body = failed
        ? (result.error ?? 'The run failed.')
        : result.summary || 'Finished with nothing to report.'

      try {
        const notification = new Notification({
          title: failed ? `${task.name} failed` : task.name,
          body: trim(body),
          // Silent on success: an hourly task that pings every hour gets muted
          // by the user within a day, and then the failures go unheard too.
          silent: !failed
        })

        notification.on('click', () => {
          const target = getWindow()
          if (target) {
            if (target.isMinimized()) target.restore()
            target.focus()
          }
          if (result.sessionId) onOpenSession(result.sessionId)
        })

        notification.show()
      } catch (error) {
        // Notification construction can throw on a misconfigured desktop.
        console.error('[notify] could not show notification', error)
      }
    }
  }
}

function trim(text: string): string {
  const single = text.replace(/\s+/g, ' ').trim()
  return single.length > MAX_BODY_CHARS ? `${single.slice(0, MAX_BODY_CHARS).trimEnd()}…` : single
}
