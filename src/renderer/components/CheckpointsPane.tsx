import { useCallback, useEffect, useState } from 'react'
import type { Checkpoint } from '../../preload'
import { useT } from '../i18n'
import { useStore } from '../store'

/**
 * Undo, at the scale of a whole turn.
 *
 * The review screen rejects one edit. This puts the workspace back to how it
 * was before the agent started — which is what you actually want after a turn
 * that touched nine files and got the shape wrong. `git checkout` is no answer
 * when the work it would discard is your own uncommitted work.
 */
export default function CheckpointsPane() {
  const t = useT()
  const [points, setPoints] = useState<Checkpoint[]>([])
  const [busy, setBusy] = useState<string | null>(null)
  const [confirming, setConfirming] = useState<string | null>(null)
  const pushNotice = useStore((state) => state.pushNotice)
  const pushError = useStore((state) => state.pushError)

  const refresh = useCallback(async () => {
    setPoints(await window.forge.checkpoints.list().catch(() => []))
  }, [])

  useEffect(() => {
    void refresh()
    return window.forge.checkpoints.onChanged(() => void refresh())
  }, [refresh])

  const restore = async (point: Checkpoint): Promise<void> => {
    setBusy(point.id)
    setConfirming(null)
    try {
      const result = await window.forge.checkpoints.restore(point.id)
      pushNotice(
        `${t('Restored')} ${result.restored} ${t('files')}` +
          (result.problems.length ? ` · ${result.problems.length} ${t('could not be restored')}` : '')
      )
      // Reported rather than swallowed: a partial restore leaves the workspace
      // in a state nobody asked for, and saying so is the least it can do.
      for (const problem of result.problems) pushError(problem)
    } catch (error) {
      pushError((error as Error).message)
    } finally {
      setBusy(null)
      void refresh()
    }
  }

  return (
    <div className="tasks">
      <header className="tasks-head">
        <div>
          <h1>{t('Checkpoints')}</h1>
          <p className="tasks-sub">
            {t(
              'Every turn that changed a file is recorded here. Restoring one puts those files back to how they were before that turn — including files it created, which are removed again.'
            )}
          </p>
        </div>
      </header>

      {points.length === 0 && (
        <div className="tasks-empty">
          <p>{t('Nothing to undo yet.')}</p>
          <p className="hint">
            {t('A checkpoint is written whenever a turn changes something on disk.')}
          </p>
        </div>
      )}

      <div className="tasks-list">
        {points.map((point) => (
          <div className="task-row" key={point.id}>
            <div className="task-main" style={{ cursor: 'default' }}>
              <span className="task-name">{point.label}</span>
              <span className="task-meta">
                {when(point.createdAt)}
                <span className="task-perm">
                  {point.files.length} {point.files.length === 1 ? t('file') : t('files')}
                </span>
              </span>
              <span className="task-last">
                {point.files
                  .slice(0, 4)
                  .map((file) => shortName(file.path))
                  .join(', ')}
                {point.files.length > 4 ? ` +${point.files.length - 4}` : ''}
              </span>
            </div>

            <div className="task-actions">
              {confirming === point.id ? (
                <>
                  <button className="btn btn-danger" onClick={() => void restore(point)}>
                    {t('Put these files back')}
                  </button>
                  <button className="icon-btn" onClick={() => setConfirming(null)}>
                    ×
                  </button>
                </>
              ) : (
                <button
                  className="btn ghost"
                  disabled={busy === point.id}
                  onClick={() => setConfirming(point.id)}
                >
                  {busy === point.id ? t('Restoring…') : t('Restore')}
                </button>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

function shortName(absolute: string): string {
  const parts = absolute.split(/[\\/]/)
  return parts[parts.length - 1] || absolute
}

function when(at: number): string {
  const delta = Date.now() - at
  const minutes = Math.round(delta / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} min ago`

  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} h ago`
  return new Date(at).toLocaleDateString()
}
